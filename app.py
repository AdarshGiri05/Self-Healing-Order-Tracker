import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from flask import Flask, abort, jsonify, render_template, request, url_for
from waitress import serve

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
DB_PATH = os.path.join(os.path.dirname(__file__), "tracker.db")
logger = logging.getLogger("self_healing")
logging.basicConfig(level=logging.INFO, format="%(message)s")


@app.context_processor
def inject_asset_version():
    def asset_version(filename):
        asset_path = os.path.join(app.static_folder, filename)
        return str(os.stat(asset_path).st_mtime_ns)

    return {"asset_version": asset_version}


VALID_STATUSES = {"Processing", "In Transit", "Delivered", "Cancelled"}
AUTO_HEAL_STEP_SECONDS = 5
ORDER_STATUS_STEP_SECONDS = 10
runtime_lock = threading.RLock()
runtime = {
    "worker_healthy": True,
    "worker_watchdog_paused": False,
    "tracking_available": True,
    "tracking_failures": 0,
    "circuit_state": "closed",
    "circuit_opened_at": None,
    "transient_failures": 0,
    "auto_heal_running": False,
    "auto_heal_stage": "idle",
    "order_auto_progress_enabled": False,
}
order_cache = {}
order_backups = {}
watchdog_started = False


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def normalize_driver_phone(value):
    phone = str(value or "").strip()
    if not re.fullmatch(r"\+?[\d\s().-]+", phone):
        raise ValueError("Enter a valid driver phone number.")
    digits = re.sub(r"\D", "", phone)
    if not 7 <= len(digits) <= 15:
        raise ValueError("Driver phone number must contain 7 to 15 digits.")
    return ("+" if phone.startswith("+") else "") + digits


def parse_timestamp(value):
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=5)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def log_event(incident_id, stage, details):
    occurred_at = timestamp()
    with db() as con:
        con.execute(
            "INSERT INTO incident_events (incident_id, stage, occurred_at, details) VALUES (?, ?, ?, ?)",
            (incident_id, stage, occurred_at, details),
        )
    logger.info(json.dumps({
        "event": "incident_lifecycle",
        "incident_id": incident_id,
        "stage": stage,
        "timestamp": occurred_at,
        "details": details,
    }))
    return occurred_at


def create_incident(component, problem, injected_at=None):
    incident_id = "INC" + uuid.uuid4().hex[:8].upper()
    detected_at = timestamp()
    injected_at = injected_at or detected_at
    with db() as con:
        con.execute(
            """INSERT INTO incidents
               (id, component, problem, stage, action, detected_at, recovered_at,
                injected_at, diagnosed_at, action_taken_at, detection_ms, recovery_ms,
                mechanism, attempts)
               VALUES (?, ?, ?, 'Detected', 'Investigating', ?, NULL, ?, NULL, NULL,
                       NULL, NULL, '', 0)""",
            (incident_id, component, problem, detected_at, injected_at),
        )
    log_event(incident_id, "Detected", problem)
    return incident_id


def update_incident(incident_id, stage, action, mechanism=None, attempts=None):
    occurred_at = timestamp()
    with db() as con:
        incident = con.execute(
            "SELECT injected_at FROM incidents WHERE id=?", (incident_id,)
        ).fetchone()
        if incident is None:
            raise ValueError(f"Incident {incident_id} does not exist")
        detection_ms = max(
            0,
            int((parse_timestamp(occurred_at) -
                 parse_timestamp(incident["injected_at"])).total_seconds() * 1000),
        )
        if stage == "Diagnosed":
            con.execute(
                """UPDATE incidents SET stage=?, action=?, diagnosed_at=?, detection_ms=?,
                   mechanism=COALESCE(?, mechanism), attempts=COALESCE(?, attempts) WHERE id=?""",
                (stage, action, occurred_at, detection_ms, mechanism, attempts, incident_id),
            )
        elif stage == "Action Taken":
            con.execute(
                """UPDATE incidents SET stage=?, action=?, action_taken_at=?,
                   mechanism=COALESCE(?, mechanism), attempts=COALESCE(?, attempts) WHERE id=?""",
                (stage, action, occurred_at, mechanism, attempts, incident_id),
            )
        elif stage == "Recovered":
            con.execute(
                """UPDATE incidents SET stage=?, action=?, recovered_at=?, recovery_ms=?,
                   mechanism=COALESCE(?, mechanism), attempts=COALESCE(?, attempts) WHERE id=?""",
                (stage, action, occurred_at, detection_ms, mechanism, attempts, incident_id),
            )
        else:
            raise ValueError(f"Unsupported incident stage: {stage}")
    log_event(incident_id, stage, action)
    return occurred_at


def complete_incident(incident_id, diagnosis, action, mechanism, attempts=1):
    update_incident(incident_id, "Diagnosed", diagnosis, mechanism, attempts)
    update_incident(incident_id, "Action Taken", action, mechanism, attempts)
    update_incident(incident_id, "Recovered", f"Health check passed: {action}", mechanism, attempts)


def init_db():
    with db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, customer TEXT NOT NULL, item TEXT NOT NULL,
          amount REAL NOT NULL, status TEXT NOT NULL, city TEXT NOT NULL,
          created_at TEXT NOT NULL, latitude REAL, longitude REAL,
          location_updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS drivers (
          phone TEXT PRIMARY KEY, portal_token TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY, component TEXT NOT NULL, problem TEXT NOT NULL,
          stage TEXT NOT NULL, action TEXT NOT NULL, detected_at TEXT NOT NULL,
          recovered_at TEXT, injected_at TEXT, diagnosed_at TEXT, action_taken_at TEXT,
          detection_ms INTEGER, recovery_ms INTEGER, mechanism TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS incident_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL,
          stage TEXT NOT NULL, occurred_at TEXT NOT NULL, details TEXT NOT NULL,
          FOREIGN KEY (incident_id) REFERENCES incidents(id)
        );
        """)
        incident_columns = {
            row["name"] for row in con.execute("PRAGMA table_info(incidents)")
        }
        order_columns = {
            row["name"] for row in con.execute("PRAGMA table_info(orders)")
        }
        for column in ("latitude", "longitude", "location_updated_at"):
            if column not in order_columns:
                column_type = "TEXT" if column == "location_updated_at" else "REAL"
                con.execute(f"ALTER TABLE orders ADD COLUMN {column} {column_type}")
        if "status_updated_at" not in order_columns:
            con.execute("ALTER TABLE orders ADD COLUMN status_updated_at TEXT")
        if "driver_phone" not in order_columns:
            con.execute("ALTER TABLE orders ADD COLUMN driver_phone TEXT")
        if "driver_accepted_at" not in order_columns:
            con.execute("ALTER TABLE orders ADD COLUMN driver_accepted_at TEXT")
        con.execute(
            "UPDATE orders SET status_updated_at=created_at WHERE status_updated_at IS NULL"
        )
        con.execute(
            "UPDATE orders SET location_updated_at=created_at "
            "WHERE location_updated_at IS NULL AND latitude IS NOT NULL "
            "AND longitude IS NOT NULL"
        )
        con.execute(
            "UPDATE orders SET status_updated_at=? "
            "WHERE status IN ('Processing', 'In Transit')",
            (timestamp(),),
        )
        migrations = {
            "injected_at": "TEXT",
            "diagnosed_at": "TEXT",
            "action_taken_at": "TEXT",
            "detection_ms": "INTEGER",
            "recovery_ms": "INTEGER",
            "mechanism": "TEXT NOT NULL DEFAULT ''",
            "attempts": "INTEGER NOT NULL DEFAULT 0",
        }
        for column, sql_type in migrations.items():
            if column not in incident_columns:
                con.execute(f"ALTER TABLE incidents ADD COLUMN {column} {sql_type}")
        con.execute(
            "UPDATE incidents SET injected_at=detected_at WHERE injected_at IS NULL"
        )
        if con.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 0:
            now = timestamp()
            con.executemany(
                """INSERT INTO orders
                   (id, customer, item, amount, status, city, created_at, status_updated_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                [
                    ("ORD1001", "Rahul Sharma", "Wireless Headphones", 1499, "Delivered", "Jaipur", now, now),
                    ("ORD1002", "Priya Verma", "Smart Watch", 899, "In Transit", "Ajmer", now, now),
                    ("ORD1003", "Aman Singh", "Bluetooth Speaker", 2199, "Processing", "Delhi", now, now),
                ],
            )
        for row in con.execute("SELECT id, status FROM orders"):
            order_cache[row["id"]] = row["status"]


def order_status_worker():
    next_status = {"Processing": "In Transit", "In Transit": "Delivered"}
    while True:
        time.sleep(1)
        with runtime_lock:
            enabled = runtime["order_auto_progress_enabled"]
        if not enabled:
            continue
        try:
            now = datetime.now(timezone.utc)
            with db() as con:
                candidates = con.execute(
                    "SELECT id, status, status_updated_at FROM orders "
                    "WHERE status IN ('Processing', 'In Transit')"
                ).fetchall()
                for order in candidates:
                    if not order["status_updated_at"]:
                        continue
                    elapsed = (now - parse_timestamp(order["status_updated_at"])).total_seconds()
                    if elapsed < ORDER_STATUS_STEP_SECONDS:
                        continue
                    updated_status = next_status[order["status"]]
                    updated_at = timestamp()
                    cursor = con.execute(
                        "UPDATE orders SET status=?, status_updated_at=? "
                        "WHERE id=? AND status=?",
                        (updated_status, updated_at, order["id"], order["status"]),
                    )
                    if not cursor.rowcount:
                        continue
                    order_cache[order["id"]] = updated_status
                    logger.info(json.dumps({
                        "event": "order_status_progression",
                        "order_id": order["id"],
                        "status": updated_status,
                        "timestamp": updated_at,
                    }))
        except (sqlite3.Error, ValueError):
            logger.exception("Automatic order status progression failed")


def start_order_status_worker():
    thread = threading.Thread(
        target=order_status_worker, name="order-status-progression", daemon=True
    )
    thread.start()


def watchdog():
    while True:
        time.sleep(0.1)
        with runtime_lock:
            if runtime["worker_healthy"] or runtime["worker_watchdog_paused"]:
                continue
            incident_id = runtime.get("worker_incident_id")
            runtime["worker_healthy"] = True
            runtime.pop("worker_incident_id", None)
        if incident_id:
            update_incident(
                incident_id, "Diagnosed", "Worker heartbeat missed; restart required",
                "Watchdog automatic restart",
            )
            update_incident(
                incident_id, "Action Taken", "Restarted the simulated order worker",
                "Watchdog automatic restart",
            )
            update_incident(
                incident_id, "Recovered", "Worker health check passed after restart",
                "Watchdog automatic restart",
            )


def start_watchdog():
    global watchdog_started
    with runtime_lock:
        if watchdog_started:
            return
        thread = threading.Thread(target=watchdog, name="order-worker-watchdog", daemon=True)
        thread.start()
        watchdog_started = True


def order_from_database(order_id):
    with db() as con:
        row = con.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    return dict(row) if row else None


def tracking_lookup(order_id):
    now = time.monotonic()
    with runtime_lock:
        if runtime["circuit_state"] == "open":
            opened_at = runtime["circuit_opened_at"] or now
            if now - opened_at < 5:
                return order_cache.get(order_id), True
            runtime["circuit_state"] = "half-open"
        available = runtime["tracking_available"]
    if available:
        order = order_from_database(order_id)
        if order:
            order_cache[order_id] = order["status"]
            with runtime_lock:
                runtime["tracking_failures"] = 0
                runtime["circuit_state"] = "closed"
                runtime["circuit_opened_at"] = None
            return order["status"], False
        return None, False
    with runtime_lock:
        runtime["tracking_failures"] += 1
        if runtime["tracking_failures"] >= 3:
            runtime["circuit_state"] = "open"
            runtime["circuit_opened_at"] = now
    return order_cache.get(order_id), True


def health_components():
    with runtime_lock:
        worker_healthy = runtime["worker_healthy"]
        tracking_available = runtime["tracking_available"]
        circuit_state = runtime["circuit_state"]
        transient_failures = runtime["transient_failures"]
    try:
        with db() as con:
            con.execute("SELECT 1").fetchone()
        database_status = "green"
    except sqlite3.Error:
        database_status = "red"
    return [
        {"name": "Python API", "status": "green" if worker_healthy else "red",
         "detail": "Worker heartbeat healthy" if worker_healthy else "Worker stopped"},
        {"name": "SQLite database", "status": database_status,
         "detail": "Orders and incidents available" if database_status == "green" else "Database check failed"},
        {"name": "Tracking provider", "status": "green" if tracking_available else "red",
         "detail": "Connected" if tracking_available else "Connection unavailable"},
        {"name": "Circuit breaker", "status": "amber" if circuit_state != "closed" else "green",
         "detail": f"Circuit {circuit_state}"},
        {"name": "Retry queue", "status": "amber" if transient_failures else "green",
         "detail": f"{transient_failures} transient failures pending"},
    ]


@app.route("/")
def home():
    return render_template("index.html")


@app.get("/driver/<token>")
def driver_portal(token):
    with db() as con:
        driver = con.execute(
            "SELECT phone FROM drivers WHERE portal_token=?", (token,)
        ).fetchone()
    if driver is None:
        abort(404)
    return render_template("driver.html", driver_phone=driver["phone"], driver_token=token)


@app.get("/api/dashboard")
def dashboard():
    with db() as con:
        orders = con.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        total = con.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]
        recovered = con.execute(
            "SELECT COUNT(*) FROM incidents WHERE stage='Recovered'"
        ).fetchone()[0]
        active = total - recovered
    components = health_components()
    statuses = [component["status"] for component in components]
    overall = "Unhealthy" if "red" in statuses else "Degraded" if "amber" in statuses else "Healthy"
    return jsonify({
        "total_orders": orders,
        "total_incidents": total,
        "active_incidents": active,
        "recovered_incidents": recovered,
        "recovery_success_rate": round(recovered / total * 100, 1) if total else 100,
        "system_status": overall,
        "components": components,
    })


@app.get("/api/health")
def health():
    components = health_components()
    states = [component["status"] for component in components]
    overall = "red" if "red" in states else "amber" if "amber" in states else "green"
    with runtime_lock:
        auto_heal_stage = runtime["auto_heal_stage"]
    return jsonify({"status": overall, "components": components, "auto_heal_stage": auto_heal_stage})


@app.post("/api/auto-heal")
@app.post("/api/auto-heal/demo")
def auto_heal():
    with runtime_lock:
        if runtime["auto_heal_running"]:
            return jsonify({"error": "An auto-heal run is already in progress."}), 409
        runtime["auto_heal_running"] = True
        runtime["auto_heal_stage"] = "detecting"
    try:
        return run_auto_heal()
    finally:
        with runtime_lock:
            runtime["auto_heal_running"] = False
            runtime["auto_heal_stage"] = "idle"


@app.post("/api/auto-heal/problem")
def inject_auto_heal_problem():
    data = request.get_json(silent=True) or {}
    problem_type = data.get("problem")
    try:
        problem = create_auto_heal_problem(problem_type)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except sqlite3.Error as error:
        logger.exception("Could not inject the selected self-healing problem")
        return jsonify({"error": f"Could not create the test problem: {error}"}), 503
    return jsonify({
        "message": f"Problem created: {problem['description']}. Select Detect & Auto-Heal to repair it.",
        **problem,
    }), 201


@app.post("/api/auto-heal/problems")
def inject_auto_heal_problems():
    data = request.get_json(silent=True)
    problem_types = data.get("problems") if isinstance(data, dict) else None
    supported = {
        "worker_crash", "tracking_outage", "circuit_breaker",
        "retry_backlog", "corrupt_order",
    }
    if (not isinstance(problem_types, list) or not problem_types
            or any(not isinstance(problem_type, str) or problem_type not in supported
                   for problem_type in problem_types)):
        return jsonify({
            "error": "Select one or more supported problems before starting auto-heal."
        }), 400

    try:
        if "corrupt_order" in problem_types:
            with db() as con:
                if con.execute("SELECT 1 FROM orders LIMIT 1").fetchone() is None:
                    return jsonify({
                        "error": "Create an order before simulating invalid order data."
                    }), 400
        problems = [create_auto_heal_problem(problem_type) for problem_type in dict.fromkeys(problem_types)]
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except sqlite3.Error as error:
        logger.exception("Could not inject selected self-healing problems")
        return jsonify({"error": f"Could not create the test problems: {error}"}), 503
    return jsonify({
        "message": f"Created {len(problems)} selected problem(s). Starting live detection and repair.",
        "problems": problems,
    }), 201


def create_auto_heal_problem(problem_type):
    if problem_type not in {
        "worker_crash", "tracking_outage", "circuit_breaker",
        "retry_backlog", "corrupt_order",
    }:
        raise ValueError("Choose one of the listed self-healing problems.")

    injected_at = timestamp()
    if problem_type == "worker_crash":
        with runtime_lock:
            runtime["worker_watchdog_paused"] = True
            runtime["worker_healthy"] = False
            incident_id = create_incident(
                "Order worker", "Order processing worker stopped unexpectedly", injected_at
            )
            runtime["worker_incident_id"] = incident_id
        description = "Order worker is stopped"
    elif problem_type == "tracking_outage":
        with runtime_lock:
            runtime["tracking_available"] = False
            incident_id = create_incident(
                "Tracking provider", "Live tracking provider is unavailable", injected_at
            )
        description = "Tracking provider is unavailable"
    elif problem_type == "circuit_breaker":
        with runtime_lock:
            runtime["circuit_state"] = "open"
            runtime["circuit_opened_at"] = time.monotonic()
            incident_id = create_incident(
                "Circuit breaker", "Circuit breaker is stuck open", injected_at
            )
        description = "Circuit breaker is stuck open"
    elif problem_type == "retry_backlog":
        with runtime_lock:
            runtime["transient_failures"] = 3
            incident_id = create_incident(
                "Retry queue", "Order processing retries are backing up", injected_at
            )
        description = "Order processing retry queue is backed up"
    else:
        with db() as con:
            order = con.execute(
                "SELECT id, status FROM orders ORDER BY id LIMIT 1"
            ).fetchone()
            if order is None:
                raise ValueError("Create an order before simulating invalid order data.")
            order_backups[order["id"]] = order["status"]
            con.execute(
                "UPDATE orders SET status='Corrupt' WHERE id=?", (order["id"],)
            )
        incident_id = create_incident(
            "Order data", "Order record contains an invalid status", injected_at
        )
        description = "An order record has an invalid status"

    return {
        "problem": problem_type,
        "incident_id": incident_id,
        "description": description,
        "component": {
            "worker_crash": "Order worker",
            "tracking_outage": "Tracking provider",
            "circuit_breaker": "Circuit breaker",
            "retry_backlog": "Retry queue",
            "corrupt_order": "Order data",
        }[problem_type],
        "issue": {
            "worker_crash": "Order processing stopped because the worker is unhealthy.",
            "tracking_outage": "Shipment tracking cannot reach its provider.",
            "circuit_breaker": "Tracking requests are blocked by an open circuit.",
            "retry_backlog": "Pending transient failures have accumulated in the retry queue.",
            "corrupt_order": "An order has a status outside the supported order lifecycle.",
        }[problem_type],
        "repair": {
            "worker_crash": "Restart the worker and confirm its heartbeat.",
            "tracking_outage": "Restore the tracking provider connection.",
            "circuit_breaker": "Reset the circuit breaker and restore tracking.",
            "retry_backlog": "Clear stale retry failures.",
            "corrupt_order": "Restore the order status from its last-known snapshot.",
        }[problem_type],
    }


def run_auto_heal():
    components = health_components()
    component_status = {component["name"]: component["status"] for component in components}
    if component_status.get("SQLite database") == "red":
        logger.error("Auto-heal could not run: SQLite health check failed")
        return jsonify({
            "error": "SQLite database is unavailable. The app cannot safely record or repair incidents."
        }), 503

    findings = []
    if component_status.get("Python API") == "red":
        findings.append({
            "component": "Order worker",
            "problem": "Worker heartbeat is unhealthy",
            "diagnosis": "Order worker heartbeat check failed",
            "action": "Restarted the simulated order worker and verified its heartbeat",
            "mechanism": "Manual health-check restart",
        })
    if component_status.get("Tracking provider") == "red":
        findings.append({
            "component": "Tracking provider",
            "problem": "Tracking provider is unavailable",
            "diagnosis": "Tracking provider health check failed",
            "action": "Restored the simulated tracking provider and cleared its failure state",
            "mechanism": "Provider recovery",
        })
    if component_status.get("Circuit breaker") == "amber":
        findings.append({
            "component": "Circuit breaker",
            "problem": "Circuit breaker is not closed",
            "diagnosis": "Circuit breaker health check reported a degraded state",
            "action": "Reset the circuit breaker to its closed state",
            "mechanism": "Circuit breaker reset",
        })
    if component_status.get("Retry queue") == "amber":
        findings.append({
            "component": "Retry queue",
            "problem": "Transient retries are still pending",
            "diagnosis": "Retry queue health check reported pending failures",
            "action": "Cleared the stale transient retry state",
            "mechanism": "Retry queue recovery",
        })

    try:
        with db() as con:
            invalid_orders = con.execute(
                "SELECT id, status FROM orders"
            ).fetchall()
    except sqlite3.Error as error:
        logger.exception("Auto-heal could not inspect order records")
        return jsonify({"error": f"Could not inspect order records: {error}"}), 503

    invalid_orders = [row for row in invalid_orders if row["status"] not in VALID_STATUSES]
    if invalid_orders:
        findings.append({
            "component": "Order data",
            "problem": f"{len(invalid_orders)} order record(s) have an invalid status",
            "diagnosis": "Order statuses were checked against the allowed lifecycle",
            "action": "",
            "mechanism": "Self-repair from last-known snapshot",
        })

    component_health = {component["name"].casefold(): component["status"] for component in components}
    incident_health = {
        "order api": "python api",
        "order worker": "python api",
        "python api": "python api",
        "database": "sqlite database",
        "sqlite database": "sqlite database",
        "tracking": "tracking provider",
        "tracking provider": "tracking provider",
        "circuit breaker": "circuit breaker",
        "retry queue": "retry queue",
    }
    try:
        with db() as con:
            pending_incidents = con.execute(
                "SELECT id, component, problem, stage FROM incidents "
                "WHERE stage != 'Recovered' ORDER BY detected_at"
            ).fetchall()
    except sqlite3.Error as error:
        logger.exception("Auto-heal could not inspect unresolved incidents")
        return jsonify({"error": f"Could not inspect unresolved incidents: {error}"}), 503

    for incident in pending_incidents:
        matching_finding = next(
            (finding for finding in findings
             if finding["component"].casefold() == incident["component"].strip().casefold()),
            None,
        )
        if matching_finding:
            if "incident_id" in matching_finding:
                if matching_finding["incident_id"] != incident["id"]:
                    findings.append({
                        **matching_finding,
                        "incident_id": incident["id"],
                        "existing_stage": incident["stage"],
                    })
            else:
                matching_finding["incident_id"] = incident["id"]
                matching_finding["existing_stage"] = incident["stage"]
            continue
        health_component = incident_health.get(incident["component"].strip().casefold())
        if not health_component or component_health.get(health_component) != "green":
            continue
        findings.append({
            "incident_id": incident["id"],
            "existing_stage": incident["stage"],
            "component": incident["component"],
            "problem": incident["problem"],
            "diagnosis": f"Live health check confirmed {health_component} is healthy",
            "action": "Health check passed; no ongoing error detected and incident marked recovered",
            "mechanism": "Auto-heal health verification",
        })

    if not findings:
        with runtime_lock:
            runtime["auto_heal_stage"] = "verifying"
        return jsonify({
            "message": "Health check complete. No issues found; all monitored components are healthy.",
            "recovered": [],
        })

    time.sleep(AUTO_HEAL_STEP_SECONDS)
    with runtime_lock:
        runtime["auto_heal_stage"] = "diagnosing"
    time.sleep(AUTO_HEAL_STEP_SECONDS)

    worker_incident_id = None
    with runtime_lock:
        if component_status.get("Python API") == "red":
            if runtime["worker_healthy"]:
                findings = [finding for finding in findings
                            if finding["component"] != "Order worker"]
            else:
                worker_incident_id = runtime.get("worker_incident_id")
    if not findings:
        with runtime_lock:
            runtime["auto_heal_stage"] = "verifying"
        return jsonify({
            "message": "Health check complete. No issues found; all monitored components are healthy.",
            "recovered": [],
        })

    recovered = []
    for finding in findings:
        if "incident_id" not in finding and finding["component"] == "Order worker" and worker_incident_id:
            with db() as con:
                existing = con.execute(
                    "SELECT stage FROM incidents WHERE id=?", (worker_incident_id,)
                ).fetchone()
            existing_stage = existing["stage"] if existing else None
            if existing_stage in {"Detected", "Diagnosed", "Action Taken"}:
                finding["incident_id"] = worker_incident_id
                finding["existing_stage"] = existing_stage
        if "incident_id" not in finding:
            finding["incident_id"] = create_incident(
                finding["component"], finding["problem"]
            )

    with runtime_lock:
        runtime["auto_heal_stage"] = "healing"
    with runtime_lock:
        if component_status.get("Python API") == "red":
            runtime["worker_healthy"] = True
            runtime["worker_watchdog_paused"] = False
            runtime.pop("worker_incident_id", None)
        if (component_status.get("Tracking provider") == "red" or
                component_status.get("Circuit breaker") == "amber"):
            runtime["tracking_available"] = True
            runtime["tracking_failures"] = 0
            runtime["circuit_state"] = "closed"
            runtime["circuit_opened_at"] = None
        if component_status.get("Retry queue") == "amber":
            runtime["transient_failures"] = 0

    for finding in findings:
        if finding["component"] == "Order data":
            repaired = repair_order_records()
            finding["action"] = f"Restored {repaired} invalid order record(s) and verified their statuses"

    time.sleep(AUTO_HEAL_STEP_SECONDS)
    with runtime_lock:
        runtime["auto_heal_stage"] = "verifying"
    time.sleep(AUTO_HEAL_STEP_SECONDS)

    verified_components = {
        component["name"].casefold(): component["status"]
        for component in health_components()
    }
    failed_components = [
        finding["component"]
        for finding in findings
        if (incident_health.get(finding["component"].casefold()) and
            verified_components.get(
                incident_health[finding["component"].casefold()]
            ) != "green")
    ]
    try:
        with db() as con:
            invalid_remaining = [
                row for row in con.execute("SELECT id, status FROM orders")
                if row["status"] not in VALID_STATUSES
            ]
    except sqlite3.Error as error:
        logger.exception("Auto-heal could not verify repaired order records")
        return jsonify({"error": f"Could not verify repaired order records: {error}"}), 503
    if invalid_remaining:
        failed_components.append("Order data")
    if failed_components:
        logger.error("Auto-heal verification failed for: %s", ", ".join(failed_components))
        return jsonify({
            "error": "Auto-heal actions ran, but verification failed for: "
                     + ", ".join(sorted(set(failed_components)))
        }), 503

    for finding in findings:
        incident_id = finding["incident_id"]
        existing_stage = finding.get("existing_stage")
        if existing_stage:
            if existing_stage == "Detected":
                update_incident(
                    incident_id, "Diagnosed", finding["diagnosis"], finding["mechanism"]
                )
            if existing_stage in {"Detected", "Diagnosed"}:
                update_incident(
                    incident_id, "Action Taken", finding["action"], finding["mechanism"]
                )
            update_incident(
                incident_id, "Recovered",
                f"Health check passed: {finding['action']}", finding["mechanism"],
            )
        else:
            complete_incident(
                incident_id,
                finding["diagnosis"],
                finding["action"],
                finding["mechanism"],
            )
        recovered.append({
            "incident_id": incident_id,
            "component": finding["component"],
            "problem": finding["problem"],
            "diagnosis": finding["diagnosis"],
            "action": finding["action"],
            "mechanism": finding["mechanism"],
        })

    return jsonify({
        "message": f"Health check complete. Detected and healed {len(recovered)} issue(s).",
        "recovered": recovered,
    })


@app.get("/api/orders")
def get_orders():
    with db() as con:
        result = [dict(row) for row in con.execute("SELECT * FROM orders ORDER BY created_at DESC")]
    with runtime_lock:
        tracking_available = (
            runtime["tracking_available"]
            and runtime["circuit_state"] not in {"open", "half-open"}
        )
    for order in result:
        order_cache[order["id"]] = order["status"]
        order["tracking_available"] = tracking_available
    return jsonify(result)


@app.get("/api/orders/auto-progress")
def get_order_auto_progress():
    with runtime_lock:
        enabled = runtime["order_auto_progress_enabled"]
    return jsonify({
        "enabled": enabled,
        "step_seconds": ORDER_STATUS_STEP_SECONDS,
        "flow": ["Processing", "In Transit", "Delivered"],
    })


@app.post("/api/orders")
def add_order():
    data = request.get_json(silent=True) or {}
    required = ["customer", "item", "amount", "city", "driver_phone"]
    if any(not str(data.get(key, "")).strip() for key in required):
        return jsonify({"error": "Please fill all fields."}), 400
    try:
        driver_phone = normalize_driver_phone(data["driver_phone"])
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    try:
        amount = float(data["amount"])
    except (TypeError, ValueError):
        return jsonify({"error": "Amount must be a number."}), 400
    if amount < 0:
        return jsonify({"error": "Amount cannot be negative."}), 400
    order_id = "ORD" + uuid.uuid4().hex[:6].upper()
    created_at = timestamp()
    with db() as con:
        driver = con.execute(
            "SELECT portal_token FROM drivers WHERE phone=?", (driver_phone,)
        ).fetchone()
        if driver is None:
            portal_token = uuid.uuid4().hex + uuid.uuid4().hex
            con.execute(
                "INSERT INTO drivers (phone, portal_token) VALUES (?, ?)",
                (driver_phone, portal_token),
            )
        else:
            portal_token = driver["portal_token"]
        con.execute(
            """INSERT INTO orders
               (id, customer, item, amount, status, city, created_at, status_updated_at,
                driver_phone)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (order_id, data["customer"].strip(), data["item"].strip(), amount,
             "Processing", data["city"].strip(), created_at, created_at, driver_phone),
        )
    order_cache[order_id] = "Processing"
    return jsonify({
        "message": "Order created",
        "id": order_id,
        "driver_phone": driver_phone,
        "driver_portal_path": url_for("driver_portal", token=portal_token),
    }), 201


@app.get("/api/driver/<token>/orders")
def get_driver_orders(token):
    with db() as con:
        driver = con.execute(
            "SELECT phone FROM drivers WHERE portal_token=?", (token,)
        ).fetchone()
        if driver is None:
            return jsonify({"error": "Driver portal link is invalid."}), 404
        assigned_orders = [
            dict(row) for row in con.execute(
                """SELECT id, customer, item, city, status, driver_accepted_at,
                          latitude, longitude, location_updated_at
                   FROM orders WHERE driver_phone=? ORDER BY created_at DESC""",
                (driver["phone"],),
            )
        ]
    return jsonify(assigned_orders)


@app.post("/api/driver/<token>/orders/<order_id>/accept")
def accept_driver_order(token, order_id):
    with db() as con:
        driver = con.execute(
            "SELECT phone FROM drivers WHERE portal_token=?", (token,)
        ).fetchone()
        if driver is None:
            return jsonify({"error": "Driver portal link is invalid."}), 404
        order = con.execute(
            "SELECT status, driver_accepted_at FROM orders "
            "WHERE id=? AND driver_phone=?",
            (order_id, driver["phone"]),
        ).fetchone()
        if order is None:
            return jsonify({"error": "Assigned order not found."}), 404
        if order["status"] in {"Delivered", "Cancelled"}:
            return jsonify({"error": f"This order is already {order['status'].lower()}."}), 409
        accepted_at = order["driver_accepted_at"] or timestamp()
        con.execute(
            "UPDATE orders SET driver_accepted_at=? WHERE id=? AND driver_phone=?",
            (accepted_at, order_id, driver["phone"]),
        )
    return jsonify({
        "message": "Order accepted. Start location sharing to show your live position.",
        "order_id": order_id,
        "accepted_at": accepted_at,
    })


@app.post("/api/driver/<token>/orders/<order_id>/complete")
def complete_driver_order(token, order_id):
    with db() as con:
        driver = con.execute(
            "SELECT phone FROM drivers WHERE portal_token=?", (token,)
        ).fetchone()
        if driver is None:
            return jsonify({"error": "Driver portal link is invalid."}), 404
        order = con.execute(
            "SELECT status, driver_accepted_at FROM orders "
            "WHERE id=? AND driver_phone=?",
            (order_id, driver["phone"]),
        ).fetchone()
        if order is None:
            return jsonify({"error": "Assigned order not found."}), 404
        if order["status"] == "Cancelled":
            return jsonify({"error": "Cancelled orders cannot be completed."}), 409
        if not order["driver_accepted_at"]:
            return jsonify({"error": "Accept this order before completing it."}), 409
        if order["status"] != "Delivered":
            con.execute(
                "UPDATE orders SET status='Delivered', status_updated_at=? WHERE id=?",
                (timestamp(), order_id),
            )
    order_cache[order_id] = "Delivered"
    return jsonify({
        "message": "Order marked as completed.",
        "order_id": order_id,
        "status": "Delivered",
    })


@app.patch("/api/orders/<order_id>")
def update_order(order_id):
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if status not in VALID_STATUSES:
        return jsonify({"error": "Invalid status"}), 400
    with db() as con:
        cur = con.execute(
            "UPDATE orders SET status=?, status_updated_at=? WHERE id=?",
            (status, timestamp(), order_id),
        )
        if not cur.rowcount:
            return jsonify({"error": "Order not found"}), 404
    order_cache[order_id] = status
    return jsonify({"message": "Order updated"})


@app.post("/api/orders/<order_id>/complete")
def complete_order(order_id):
    with db() as con:
        order = con.execute(
            "SELECT status FROM orders WHERE id=?", (order_id,)
        ).fetchone()
        if order is None:
            return jsonify({"error": "Order not found"}), 404
        if order["status"] == "Cancelled":
            return jsonify({"error": "Cancelled orders cannot be completed."}), 409
        if order["status"] != "Delivered":
            con.execute(
                "UPDATE orders SET status='Delivered', status_updated_at=? WHERE id=?",
                (timestamp(), order_id),
            )
    order_cache[order_id] = "Delivered"
    return jsonify({
        "message": "Order marked as completed.",
        "order_id": order_id,
        "status": "Delivered",
    })


@app.get("/api/orders/<order_id>/tracking")
def track_order(order_id):
    status, fallback = tracking_lookup(order_id)
    if status is None:
        return jsonify({"error": "Order not found"}), 404
    return jsonify({
        "order_id": order_id,
        "status": status,
        "source": "last-known cache" if fallback else "tracking provider",
        "degraded": fallback,
    })


@app.get("/api/orders/<order_id>/location")
def get_order_location(order_id):
    with db() as con:
        order = con.execute(
            "SELECT id, status, latitude, longitude, location_updated_at "
            "FROM orders WHERE id=?",
            (order_id,),
        ).fetchone()
    if order is None:
        return jsonify({"error": "Order not found"}), 404
    if order["latitude"] is None or order["longitude"] is None:
        return jsonify({
            "order_id": order_id,
            "available": False,
            "message": "The delivery driver has not shared a GPS location for this order yet.",
        })
    if not order["location_updated_at"]:
        return jsonify({
            "order_id": order_id,
            "available": False,
            "message": "The saved GPS location has no update timestamp.",
        })
    updated_at = parse_timestamp(order["location_updated_at"])
    age_seconds = max(0, int((datetime.now(timezone.utc) - updated_at).total_seconds()))
    return jsonify({
        "order_id": order_id,
        "available": True,
        "latitude": order["latitude"],
        "longitude": order["longitude"],
        "updated_at": order["location_updated_at"],
        "age_seconds": age_seconds,
        "stale": age_seconds > 45,
        "status": order["status"],
    })


@app.post("/api/orders/<order_id>/location")
def update_order_location(order_id):
    return save_order_location(order_id)


@app.post("/api/driver/<token>/orders/<order_id>/location")
def update_driver_order_location(token, order_id):
    with db() as con:
        driver = con.execute(
            "SELECT phone FROM drivers WHERE portal_token=?", (token,)
        ).fetchone()
    if driver is None:
        return jsonify({"error": "Driver portal link is invalid."}), 404
    return save_order_location(order_id, driver["phone"])


def save_order_location(order_id, driver_phone=None):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Send GPS latitude and longitude as JSON."}), 400
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return jsonify({"error": "GPS latitude and longitude must be numbers."}), 400
    if (not math.isfinite(latitude) or not math.isfinite(longitude)
            or not -90 <= latitude <= 90 or not -180 <= longitude <= 180):
        return jsonify({"error": "GPS coordinates are outside the valid latitude/longitude range."}), 400
    with db() as con:
        order = con.execute(
            "SELECT status, driver_phone, driver_accepted_at FROM orders WHERE id=?",
            (order_id,),
        ).fetchone()
        if order is None:
            return jsonify({"error": "Order not found"}), 404
        if driver_phone is not None and order["driver_phone"] != driver_phone:
            return jsonify({"error": "This order is not assigned to this driver."}), 403
        if not order["driver_accepted_at"]:
            return jsonify({"error": "Accept this order before sharing your location."}), 409
        if order["status"] in {"Delivered", "Cancelled"}:
            return jsonify({
                "error": f"Location sharing is unavailable for {order['status'].lower()} orders."
            }), 409
        updated_at = timestamp()
        cursor = con.execute(
            """UPDATE orders SET latitude=?, longitude=?, location_updated_at=?,
               status=CASE WHEN status='Processing' THEN 'In Transit' ELSE status END,
               status_updated_at=CASE WHEN status='Processing' THEN ? ELSE status_updated_at END
               WHERE id=? AND status IN ('Processing', 'In Transit')""",
            (latitude, longitude, updated_at, updated_at, order_id),
        )
        if not cursor.rowcount:
            return jsonify({
                "error": "Order status changed; reload the order before sharing GPS."
            }), 409
    order_cache[order_id] = "In Transit"
    return jsonify({
        "message": "Live GPS location updated",
        "order_id": order_id,
        "updated_at": updated_at,
        "status": "In Transit",
    })


@app.get("/api/incidents")
def get_incidents():
    with db() as con:
        return jsonify([
            dict(row) for row in con.execute(
                "SELECT * FROM incidents ORDER BY detected_at DESC LIMIT 100"
            )
        ])
    @app.post("/api/chaos")
    def chaos_test():
     data=request.get_json(silent=True) or {}
    component=data.get("component","Order API")
    issue=data.get("issue","Simulated service failure")
    iid="INC"+uuid.uuid4().hex[:6].upper()
    now=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db() as con:
        con.execute("INSERT INTO incidents VALUES(?,?,?,?,?,?,?)",(iid,component,issue,"Detected","Recovery pending",now,None))
        con.execute("UPDATE incidents SET stage='Diagnosed', action='Retry with backoff' WHERE id=?",(iid,))
        time.sleep(0.25)
        con.execute("UPDATE incidents SET stage='Action Taken', action='Automatic retry / repair executed' WHERE id=?",(iid,))
        time.sleep(0.25)
        con.execute("UPDATE incidents SET stage='Recovered', action='Health check passed', recovered_at=? WHERE id=?",(datetime.now().strftime("%Y-%m-%d %H:%M:%S"),iid))
    return jsonify({"message":"Fault simulated and recovery completed","incident_id":iid,"stage":"Recovered"})


@app.get("/api/incidents/<incident_id>/events")
def incident_events(incident_id):
    with db() as con:
        events = [
            dict(row) for row in con.execute(
                "SELECT stage, occurred_at, details FROM incident_events "
                "WHERE incident_id=? ORDER BY id",
                (incident_id,),
            )
        ]
    return jsonify(events)


def repair_order_records():
    repaired = 0
    with db() as con:
        rows = con.execute("SELECT id, status FROM orders").fetchall()
        for row in rows:
            if row["status"] not in VALID_STATUSES:
                backup_status = order_backups.get(
                    row["id"], order_cache.get(row["id"], "Processing")
                )
                con.execute("UPDATE orders SET status=? WHERE id=?", (backup_status, row["id"]))
                order_cache[row["id"]] = backup_status
                repaired += 1
    return repaired


@app.post("/api/chaos")
def chaos_test():
    data = request.get_json(silent=True) or {}
    failure = data.get("failure")
    order_id = data.get("order_id")
    if failure not in {"process_crash", "network_glitch", "circuit_breaker",
                       "cached_fallback", "corrupt_record"}:
        return jsonify({"error": "Choose a supported chaos scenario."}), 400

    if failure == "process_crash":
        injected_at = timestamp()
        with runtime_lock:
            runtime["worker_watchdog_paused"] = False
            runtime["worker_healthy"] = False
            incident_id = create_incident(
                "Order worker", "Worker process stopped unexpectedly", injected_at
            )
            runtime["worker_incident_id"] = incident_id
        start_watchdog()
        return jsonify({
            "message": "Worker crash detected; watchdog restart scheduled",
            "incident_id": incident_id,
            "stage": "Detected",
            "mechanism": "Watchdog automatic restart",
            "without_healing": "Worker remains stopped and order processing stays unavailable.",
            "with_healing": "Watchdog restarts the worker and verifies its heartbeat.",
        }), 202

    if failure == "network_glitch":
        injected_at = timestamp()
        with runtime_lock:
            runtime["transient_failures"] = 2
        incident_id = create_incident(
            "Tracking provider", "Transient connection timeout", injected_at
        )
        delays = (0.1, 0.2, 0.4)
        attempts = 0
        for delay in delays:
            with runtime_lock:
                if runtime["transient_failures"] > 0:
                    runtime["transient_failures"] -= 1
                    attempts += 1
                    should_retry = True
                else:
                    should_retry = False
            if not should_retry:
                break
            time.sleep(delay)
        complete_incident(incident_id, "Transient connection timeout detected",
                          f"Connection restored after {attempts} retries; provider call succeeded on attempt {attempts + 1}",
                          "Exponential backoff", attempts + 1)
        return jsonify({
            "message": "Tracking connection recovered after exponential backoff",
            "incident_id": incident_id,
            "stage": "Recovered",
            "mechanism": "Exponential backoff",
            "attempts": attempts + 1,
            "without_healing": "The request fails during the transient provider timeout.",
            "with_healing": f"The provider succeeds on retry {attempts + 1} after exponential backoff.",
        })

    if failure in {"circuit_breaker", "cached_fallback"}:
        if not order_id:
            with db() as con:
                first = con.execute("SELECT id FROM orders ORDER BY id LIMIT 1").fetchone()
            order_id = first["id"] if first else None
        if not order_id:
            return jsonify({"error": "Create an order before testing tracking recovery."}), 400
        baseline = order_from_database(order_id)
        if baseline is None:
            return jsonify({"error": "Order not found"}), 404
        order_cache[order_id] = baseline["status"]
        with runtime_lock:
            runtime["tracking_available"] = False
            runtime["tracking_failures"] = 0
            runtime["circuit_state"] = "closed"
            runtime["circuit_opened_at"] = None
        injected_at = timestamp()
        incident_id = create_incident(
            "Tracking provider", "Upstream tracking service unavailable", injected_at
        )
        attempts = 0
        result_status = order_cache.get(order_id)
        used_fallback = False
        for _ in range(3 if failure == "circuit_breaker" else 1):
            result_status, used_fallback = tracking_lookup(order_id)
            attempts += 1
        if failure == "circuit_breaker":
            with runtime_lock:
                circuit_open = runtime["circuit_state"] == "open"
            if not circuit_open:
                raise RuntimeError("Circuit breaker did not open after the configured threshold")
            action = "Circuit opened after 3 failures; served last-known order status"
            mechanism = "Circuit breaker + cached fallback"
            without_healing = "Tracking requests fail while the provider is unavailable."
            with_healing = f"Circuit opens after {attempts} calls and returns cached status: {result_status}."
        else:
            action = "Served last-known order status without the unavailable provider"
            mechanism = "Graceful degradation / cached fallback"
            without_healing = "The tracking page shows an error while the provider is unavailable."
            with_healing = f"Tracking stays available with last-known status: {result_status}."
        complete_incident(incident_id, "Provider outage detected",
                          f"{action}; order tracking remains available: {result_status}",
                          mechanism, attempts)
        return jsonify({
            "message": action,
            "incident_id": incident_id,
            "stage": "Recovered",
            "mechanism": mechanism,
            "attempts": attempts,
            "tracking_status": result_status,
            "degraded": used_fallback,
            "without_healing": without_healing,
            "with_healing": with_healing,
        })

    injected_at = timestamp()
    with db() as con:
        row = con.execute("SELECT id, status FROM orders ORDER BY id LIMIT 1").fetchone()
        if row is None:
            return jsonify({"error": "Create an order before testing data repair."}), 400
        order_backups[row["id"]] = row["status"]
        con.execute("UPDATE orders SET status='Corrupt' WHERE id=?", (row["id"],))
    incident_id = create_incident(
        "Order data", "Invalid order status detected", injected_at
    )
    repaired = repair_order_records()
    complete_incident(incident_id, "Invalid order status found",
                      f"Order status is outside the allowed lifecycle; restored {repaired} record(s) and validation passed",
                      "Self-repair from last-known snapshot")
    return jsonify({
        "message": f"Detected and repaired {repaired} invalid order record(s)",
        "incident_id": incident_id,
        "stage": "Recovered",
        "mechanism": "Self-repair from last-known snapshot",
        "repaired_records": repaired,
        "without_healing": "The invalid status remains stored and can break tracking and reporting.",
        "with_healing": f"Restored {repaired} invalid record(s) from the last-known snapshot.",
    })


@app.post("/api/chaos/reset")
def reset_chaos():
    with runtime_lock:
        runtime.update({
            "worker_healthy": True,
            "worker_watchdog_paused": False,
            "tracking_available": True,
            "tracking_failures": 0,
            "circuit_state": "closed",
            "circuit_opened_at": None,
            "transient_failures": 0,
        })
        runtime.pop("worker_incident_id", None)
    return jsonify({"message": "Simulated service faults cleared"})


@app.get("/api/analytics")
def analytics():
    with db() as con:
        total_orders = con.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
        counts = {
            row["status"]: row["n"] for row in con.execute(
                "SELECT status, COUNT(*) n FROM orders GROUP BY status"
            )
        }
        total_incidents = con.execute("SELECT COUNT(*) FROM incidents").fetchone()[0]
        recovered = con.execute(
            "SELECT COUNT(*) FROM incidents WHERE stage='Recovered'"
        ).fetchone()[0]
        timings = con.execute(
            """SELECT AVG(detection_ms) AS mttd_ms, AVG(recovery_ms) AS mttr_ms
               FROM incidents WHERE stage='Recovered' AND detection_ms IS NOT NULL
               AND recovery_ms IS NOT NULL"""
        ).fetchone()
    return jsonify({
        "total_orders": total_orders,
        "status_counts": counts,
        "total_incidents": total_incidents,
        "recovered_incidents": recovered,
        "recovery_success_rate": round(recovered / total_incidents * 100, 1) if total_incidents else 100,
        "mttd_seconds": round((timings["mttd_ms"] or 0) / 1000, 3),
        "mttr_seconds": round((timings["mttr_ms"] or 0) / 1000, 3),
    })


init_db()
start_watchdog()
start_order_status_worker()

if __name__ == "__main__":
    serve(app, host="127.0.0.1", port=5000)
