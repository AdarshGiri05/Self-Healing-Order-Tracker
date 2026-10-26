const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let orders = [];
let recentOrdersViewAvailable = true;
let orderMap = null;
let orderRouteLayer = null;
let orderMarkersLayer = null;
let mapRenderSequence = 0;
let completingOrderId = null;
let autoHealRunning = false;
let autoHealStepIndex = 0;
const selectedAutoHealProblems = new Set();
let activeAutoHealProblems = [];
const preInjectedAutoHealProblems = new Map();
const dispatchHub = { name: "Jaipur dispatch hub (demo)", coordinates: [26.9124, 75.7873] };
const cityCoordinates = {
    ahmedabad: [23.0225, 72.5714], ajmer: [26.4499, 74.6399], amritsar: [31.6340, 74.8723],
    aurangabad: [19.8762, 75.3433], azamgarh: [26.0678, 83.1836], bengaluru: [12.9716, 77.5946], bhopal: [23.2599, 77.4126],
    bhubaneswar: [20.2961, 85.8245], chandigarh: [30.7333, 76.7794], chennai: [13.0827, 80.2707],
    coimbatore: [11.0168, 76.9558], dehradun: [30.3165, 78.0322], delhi: [28.6139, 77.2090],
    faridabad: [28.4089, 77.3178], ghaziabad: [28.6692, 77.4538], gurgaon: [28.4595, 77.0266],
    gurugram: [28.4595, 77.0266], guwahati: [26.1445, 91.7362], hyderabad: [17.3850, 78.4867],
    indore: [22.7196, 75.8577], jaipur: [26.9124, 75.7873], jalandhar: [31.3260, 75.5762],
    jodhpur: [26.2389, 73.0243], kanpur: [26.4499, 80.3319], kochi: [9.9312, 76.2673],
    kolkata: [22.5726, 88.3639], lucknow: [26.8467, 80.9462], ludhiana: [30.9010, 75.8573],
    mangaluru: [12.9141, 74.8560], mumbai: [19.0760, 72.8777], mysuru: [12.2958, 76.6394],
    nagpur: [21.1458, 79.0882], nashik: [19.9975, 73.7898], noida: [28.5355, 77.3910],
    patna: [25.5941, 85.1376], prayagraj: [25.4358, 81.8463], pune: [18.5204, 73.8567],
    raipur: [21.2514, 81.6296], rajkot: [22.3039, 70.8022], ranchi: [23.3441, 85.3096],
    surat: [21.1702, 72.8311], thiruvananthapuram: [8.5241, 76.9366], vadodara: [22.3072, 73.1812],
    varanasi: [25.3176, 82.9739], vijayawada: [16.5062, 80.6480], visakhapatnam: [17.6868, 83.2185]
};
const titles = { dashboard: "Health Dashboard", orders: "Order Tracking", incidents: "Incident Management", chaos: "Chaos Testing Lab", analytics: "Reliability Analytics" };
const componentIcons = { "Python API": "API", "SQLite database": "SQL", "Network connectivity": "NET", "Tracking provider": "↗", "Recent orders view": "ORD", "Order records": "ORD", "Circuit breaker": "CB", "Retry queue": "↻" };
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 2600) }
async function api(url, opts = {}) {
    const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
    const body = await response.text();
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        if (!response.ok && body.trimStart().startsWith("<")) {
            throw Error(`The server returned an HTML error (HTTP ${response.status}) instead of API JSON. Restart app.py, then reload this page.`);
        }
        throw Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) throw Error(data.error || `Request failed (HTTP ${response.status}).`);
    return data;
}
function badge(status) { return `<span class="badge ${status.toLowerCase().replaceAll(" ", "-")}">${esc(status)}</span>` }
function orderTrackingStatus(order) {
    return order.tracking_available === false ? "Unavailable" : order.status;
}
function updateTrackingOutageNotices(orderList) {
    const unavailableCount = orderList.filter(order => order.tracking_available === false).length;
    const outage = unavailableCount > 0;
    for (const id of ["dashboardTrackingOutageNotice", "ordersTrackingOutageNotice"]) {
        const notice = $(`#${id}`);
        if (!notice) continue;
        notice.hidden = !outage;
        if (outage) {
            const detail = notice.querySelector("small");
            detail.textContent = `${unavailableCount} order${unavailableCount === 1 ? "" : "s"} marked Unavailable while network connectivity or the tracking provider is unavailable. Click Detect & Auto-Heal on the dashboard to restore tracking.`;
        }
    }
}
function updateNetworkOutageScreen(networkAvailable) {
    const screen = $("#networkOutageScreen");
    screen.hidden = networkAvailable;
    const button = $("#networkAutoHeal");
    button.disabled = autoHealRunning;
    button.textContent = autoHealRunning ? "Self-Healing…" : "Self-Heal Network";
    $("#networkOutageStatus").textContent = autoHealRunning
        ? "Self-healing is restoring network connectivity."
        : "Network connectivity is unavailable.";
}
function renderRecentOrdersPreview(orderList) {
    $("#recentOrders").innerHTML = recentOrdersViewAvailable
        ? ordersHtml(orderList.slice(0, 4))
        : "<p class=\"message error\">Recent orders are temporarily unavailable. Click Detect &amp; Auto-Heal to restore the recent orders view.</p>";
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])) }
function renderProblemProgress(stage = "selected", recovered = [], unresolved = []) {
    const container = $("#problemProgress");
    if (!container) return;
    if (!activeAutoHealProblems.length) {
        container.hidden = true;
        container.innerHTML = "";
        return;
    }
    const completed = new Map(recovered.map(item => [item.incident_id, item]));
    const needsDriver = new Map(unresolved.map(item => [item.incident_id, item]));
    const labels = {
        selected: "Selected",
        detecting: "Detected",
        diagnosing: "Diagnosing",
        healing: "Repairing",
        verifying: "Verifying",
        healed: "Recovered",
        "needs-driver": "Driver action needed",
        failed: "Failed"
    };
    container.hidden = false;
    container.innerHTML = activeAutoHealProblems.map(problem => {
        const result = completed.get(problem.incident_id);
        const pendingDriverAction = needsDriver.get(problem.incident_id);
        const status = result ? "healed" : pendingDriverAction ? "needs-driver" : stage;
        const details = [
            pendingDriverAction?.diagnosis || problem.issue || problem.description,
            `Affected component: ${pendingDriverAction?.component || problem.component || "Pending detection"}`,
            result ? `Repair applied: ${result.action}`
                : pendingDriverAction ? `Next step: ${pendingDriverAction.action}`
                    : `Planned repair: ${problem.repair || "Waiting for health detection."}`,
            problem.incident_id ? `Incident: ${problem.incident_id}` : ""
        ].filter(Boolean);
        return `<article class="problem-progress-card ${esc(status)}" data-incident-id="${esc(problem.incident_id || "")}" tabindex="-1">
            <div class="problem-progress-heading"><strong>${esc(problem.description || problem.name)}</strong><span>${esc(labels[status] || "Selected")}</span></div>
            <small>${details.map(esc).join("<br>")}</small>
        </article>`;
    }).join("");
}
function showHealingResult(recovered, message, unresolved = []) {
    const dialog = $("#healingResultDialog");
    const details = $("#healingResultDetails");
    $("#healingResultTitle").textContent = unresolved.length
        ? "Driver GPS needs attention"
        : recovered.length
            ? `${recovered.length} issue${recovered.length === 1 ? "" : "s"} recovered`
        : "System health check passed";
    $("#healingResultSummary").textContent = message;
    details.replaceChildren();
    if (!recovered.length && !unresolved.length) {
        const healthy = document.createElement("p");
        healthy.className = "healing-result-empty";
        healthy.textContent = "No active errors were found. All monitored components and order records are healthy.";
        details.append(healthy);
    }
    recovered.forEach(item => {
        const card = document.createElement("article");
        card.className = "healing-result-card";
        const heading = document.createElement("div");
        heading.className = "healing-result-card-heading";
        const problem = document.createElement("strong");
        problem.textContent = item.problem || item.component || "Recovered issue";
        heading.append(problem);
        if (item.incident_id) {
            const incident = document.createElement("span");
            incident.textContent = item.incident_id;
            heading.append(incident);
        }
        const location = document.createElement("p");
        location.className = "healing-result-location";
        location.textContent = `Where: ${item.component || "Application health check"}`;
        const diagnosis = document.createElement("p");
        diagnosis.textContent = `What happened: ${item.diagnosis || item.problem || "An issue was detected."}`;
        const action = document.createElement("p");
        action.className = "healing-result-action";
        action.textContent = `What was fixed: ${item.action || "Recovery was verified."}`;
        card.append(heading, location, diagnosis, action);
        if (item.mechanism) {
            const mechanism = document.createElement("small");
            mechanism.textContent = `Recovery method: ${item.mechanism}`;
            card.append(mechanism);
        }
        details.append(card);
    });
    unresolved.forEach(item => {
        const card = document.createElement("article");
        card.className = "healing-result-card needs-driver";
        const heading = document.createElement("div");
        heading.className = "healing-result-card-heading";
        const problem = document.createElement("strong");
        problem.textContent = item.problem;
        const state = document.createElement("span");
        state.textContent = "Driver action needed";
        heading.append(problem, state);
        const location = document.createElement("p");
        location.className = "healing-result-location";
        location.textContent = `Where: ${item.component}`;
        const diagnosis = document.createElement("p");
        diagnosis.textContent = `What is happening: ${item.diagnosis}`;
        const action = document.createElement("p");
        action.className = "healing-result-action";
        action.textContent = `Next step: ${item.action}`;
        card.append(heading, location, diagnosis, action);
        details.append(card);
    });
    if (!dialog.open) dialog.showModal();
}
function ordersHtml(list) { if (!list.length) return "<p>No orders found.</p>"; return `<table><thead><tr><th>ORDER ID</th><th>CUSTOMER / ITEM</th><th>AMOUNT</th><th>CITY</th><th>LIVE STATUS</th></tr></thead><tbody>${list.map(o => `<tr><td class="order-id">${esc(o.id)}</td><td><b>${esc(o.customer)}</b><br><small>${esc(o.item)}</small></td><td>₹${Number(o.amount).toLocaleString("en-IN")}</td><td>${esc(o.city)}</td><td>${badge(orderTrackingStatus(o))}<br><small>${o.tracking_available === false ? "Tracking provider unavailable" : o.status === "Processing" || o.status === "In Transit" ? "Auto-updating" : "Final status"}</small></td></tr>`).join("")}</tbody></table>` }
function orderStatusTracker(status) {
    if (status === "Cancelled") {
        return `<div class="order-status-tracker cancelled" role="status"><span class="tracker-cancelled">Order cancelled</span></div>`;
    }
    const stages = ["Processing", "In Transit", "Delivered"];
    const currentIndex = Math.max(0, stages.indexOf(status));
    const steps = stages.map((stage, index) =>
        `<span class="order-status-step ${index < currentIndex ? "complete" : ""} ${index === currentIndex ? `current ${status === "Delivered" ? "delivered" : ""}` : ""}"><i>${index < currentIndex ? "✓" : index + 1}</i><small>${stage}</small></span>`
    ).join("");
    return `<div class="order-status-tracker" role="progressbar" aria-label="Order status: ${esc(status)}" aria-valuemin="1" aria-valuemax="3" aria-valuenow="${currentIndex + 1}"><span class="order-status-track"><i style="width:${currentIndex * 50}%"></i></span>${steps}</div>`;
}
function trackedOrdersHtml(list) {
    if (!list.length) return "<p>No orders found.</p>";
    return `<table class="order-tracking-table"><thead><tr><th>ORDER ID</th><th>CUSTOMER / ITEM</th><th>DRIVER PHONE</th><th>AMOUNT</th><th>CITY</th><th>LIVE STATUS</th></tr></thead><tbody>${list.map(order => {
        if (order.tracking_available === false) {
            return `<tr class="tracking-unavailable-row"><td class="order-id">${esc(order.id)}</td><td><b>${esc(order.customer)}</b><br><small>${esc(order.item)}</small></td><td>${esc(order.driver_phone || "—")}</td><td>₹${Number(order.amount).toLocaleString("en-IN")}</td><td>${esc(order.city)}</td><td>${badge("Unavailable")}<small class="tracker-caption">Tracking provider unavailable</small></td></tr>`;
        }
        const statusCaption = ["Delivered", "Cancelled"].includes(order.status)
            ? "Final status"
            : order.driver_accepted_at ? "Live order progress" : "Awaiting driver acceptance";
        return `<tr><td class="order-id">${esc(order.id)}</td><td><b>${esc(order.customer)}</b><br><small>${esc(order.item)}</small></td><td>${esc(order.driver_phone || "—")}</td><td>₹${Number(order.amount).toLocaleString("en-IN")}</td><td>${esc(order.city)}</td><td>${badge(order.status)}<small class="tracker-caption">${statusCaption}</small>${orderStatusTracker(order.status)}</td></tr>`;
    }).join("")}</tbody></table>`;
}
function formatTime(value) { return value ? new Date(value).toLocaleString() : "—" }
function setAutoHealProgress(stage, title, detail) {
    const stageIndexes = { running: 0, detecting: 0, diagnosing: 1, healing: 2, verifying: 3, healed: 4 };
    if (Object.hasOwn(stageIndexes, stage) && stageIndexes[stage] < autoHealStepIndex) return;
    const state = ["detecting", "diagnosing", "healing", "verifying", "healed", "failed"].includes(stage) ? stage : "running";
    const status = $("#healingWindowStatus");
    status.className = `healing-window-status ${state}`;
    $("#healingWindowIcon").textContent = stage === "healed" ? "✓" : ["detecting", "healing", "verifying"].includes(stage) ? "" : stage === "failed" ? "×" : "!";
    $("#healingWindowTitle").textContent = title;
    $("#healingWindowDetail").textContent = detail;
    const stepDetails = {
        running: [
            "Preparing component health and order-data checks.",
            "Waiting for detected issues to be classified.",
            "Waiting for diagnosis before applying supported repairs.",
            "The app will verify component health and repaired records."
        ],
        detecting: [
            "Checking app components, service flags, retries, and order statuses.",
            "Waiting for detected issues to be classified.",
            "Waiting for diagnosis before applying supported repairs.",
            "The app will verify component health and repaired records."
        ],
        diagnosing: [
            "Health checks and order data have been scanned.",
            "Matching each issue to an available in-app repair.",
            "Waiting for diagnosis before applying supported repairs.",
            "The app will verify component health and repaired records."
        ],
        healing: [
            "Issues and repair actions have been identified.",
            "Incident records are being updated with the diagnosis.",
            "Repairing supported runtime flags, retry state, and invalid order data.",
            "The app will verify component health and repaired records."
        ],
        verifying: [
            "Issues and repair actions have been identified.",
            "Incident records contain the diagnosis.",
            "Supported repairs have been applied.",
            "Rechecking component health and validating order statuses."
        ],
        healed: [
            "Live component and order-data checks completed.",
            "Detected issues were classified for repair.",
            "Supported in-app repairs were applied where needed.",
            "Post-repair health and order-data checks passed."
        ],
        failed: [
            "Preparing component health and order-data checks.",
            "Classifying detected issues for repair.",
            "Applying supported runtime and order-data repairs.",
            "Verifying component health and repaired records."
        ]
    };
    if (Object.hasOwn(stageIndexes, stage)) autoHealStepIndex = stageIndexes[stage];
    const activeStages = ["detecting", "diagnosing", "healing", "verifying"];
    const contentStage = stage === "failed" ? (activeStages[autoHealStepIndex] || "running") : stage;
    $$(".healing-step").forEach((step, index) => {
        let stepDetail = (stepDetails[contentStage] || stepDetails.running)[index];
        if (stage === "failed" && index === autoHealStepIndex) {
            stepDetail = detail;
        }
        step.querySelector("small").textContent = stepDetail;
        const stepState = step.querySelector("em");
        const complete = stage === "healed" || index < autoHealStepIndex;
        const active = stage !== "healed" && index === autoHealStepIndex && index < 4;
        step.querySelector("b").textContent = complete ? "✓" : String(index + 1).padStart(2, "0");
        step.classList.toggle("complete", complete);
        step.classList.toggle("active", active && stage !== "failed");
        step.classList.toggle("failed", active && stage === "failed");
        stepState.textContent = complete ? "Complete" : active ? (stage === "failed" ? "Failed" : "In progress") : "Waiting";
    });
}
async function loadHealth() {
    const d = await api("/api/health");
    const networkComponent = d.components.find(component =>
        component.name === "Network connectivity"
    );
    updateNetworkOutageScreen(!networkComponent || networkComponent.status === "green");
    $("#serviceHealth").innerHTML = d.components.map(c => `<div class="service"><span class="service-icon ${c.status === "red" ? "red-bg" : c.status === "amber" ? "orange-bg" : "green-bg"}">${esc(componentIcons[c.name] || "•")}</span><div><b>${esc(c.name)}</b><small>${esc(c.detail)}</small></div><span class="status ${c.status === "red" ? "bad-text" : c.status === "amber" ? "warn-text" : "good-text"}">● ${c.status === "red" ? "Unhealthy" : c.status === "amber" ? "Degraded" : "Healthy"}</span></div>`).join("");
    const pill = $("#healthPill");
    pill.className = "pill " + (d.status === "green" ? "good" : "warn");
    pill.textContent = d.status === "green" ? "ALL SYSTEMS HEALTHY" : d.status === "amber" ? "DEGRADED" : "UNHEALTHY";
    if (autoHealRunning && d.auto_heal_stage === "detecting") {
        renderProblemProgress("detecting");
        const button = $("#autoHeal");
        if (button) button.textContent = "Detecting…";
        setAutoHealProgress("detecting", "DETECTING ISSUES", "Checking live component health and order data.");
    } else if (autoHealRunning && d.auto_heal_stage === "diagnosing") {
        renderProblemProgress("diagnosing");
        setAutoHealProgress("diagnosing", "DIAGNOSING ISSUES", "Classifying detected faults and choosing supported repairs.");
    } else if (autoHealRunning && d.auto_heal_stage === "healing") {
        renderProblemProgress("healing");
        const button = $("#autoHeal");
        if (button) button.textContent = "Healing…";
        setAutoHealProgress("healing", "APPLYING REPAIRS", "Repairing unhealthy runtime components and invalid order data.");
    } else if (autoHealRunning && d.auto_heal_stage === "verifying") {
        renderProblemProgress("verifying");
        setAutoHealProgress("verifying", "VERIFYING RECOVERY", "Rechecking component health and validating repaired order data.");
    }
    return d;
}
async function loadDashboard() {
    const dashboard = await api("/api/dashboard");
    $("#totalOrders").textContent = dashboard.total_orders;
    $("#activeIncidents").textContent = dashboard.active_incidents;
    $("#successRate").textContent = dashboard.recovery_success_rate + "%";
    $("#systemHealth").textContent = dashboard.system_status;
    $("#systemHealth").style.color = dashboard.system_status === "Healthy"
        ? "#19a974" : dashboard.system_status === "Degraded" ? "#e6a12b" : "#e65262";
    orders = await api("/api/orders");
    updateTrackingOutageNotices(orders);
    recentOrdersViewAvailable = dashboard.components.some(component =>
        component.name === "Recent orders view" && component.status === "green"
    );
    renderRecentOrdersPreview(orders);
}
async function loadOrders() { orders = await api("/api/orders"); updateTrackingOutageNotices(orders); const q = $("#orderSearch").value.toLowerCase(); $("#ordersTable").innerHTML = trackedOrdersHtml(orders.filter(o => [o.id, o.customer, o.item, o.city, o.driver_phone, o.status].some(v => String(v).toLowerCase().includes(q)))); renderOrderMap() }
async function findLatestDriverLocation() {
    const latestFirst = (await api("/api/orders"))
        .filter(order => order.latitude != null && order.longitude != null && order.location_updated_at)
        .sort((left, right) =>
            Date.parse(right.location_updated_at) - Date.parse(left.location_updated_at)
        );
    let latestSavedLocation = null;
    for (const order of latestFirst) {
        const location = await api(`/api/orders/${encodeURIComponent(order.id)}/location`);
        if (location.available) {
            const terminal = ["Delivered", "Cancelled"].includes(order.status);
            const result = {
                order,
                location,
                live: !location.stale && !terminal
            };
            if (result.live) return result;
            if (!latestSavedLocation) latestSavedLocation = result;
        }
    }
    return latestSavedLocation;
}
async function openDriverLocationTracking(locationResult) {
    await showPage("orders");
    const picker = $("#mapOrderSelect");
    const order = locationResult?.order ||
        orders.find(item => !["Delivered", "Cancelled"].includes(item.status));
    if (order && [...picker.options].some(option => option.value === order.id)) {
        picker.value = order.id;
        await renderOrderMap();
    }
    if (locationResult?.live) {
        const updated = formatTime(locationResult.location.updated_at);
        setLocationShareMessage(
            `Live driver GPS for order ${locationResult.order.id} is displayed on the map. Last update: ${updated}.`,
            "live"
        );
    } else if (locationResult) {
        const updated = formatTime(locationResult.location.updated_at);
        setLocationShareMessage(
            `Showing the last-known GPS for order ${locationResult.order.id}, not a live position. Last update: ${updated}. Ask the driver to resume GPS sharing.`,
            "error"
        );
    } else {
        const orderNote = order ? ` for order ${order.id}` : "";
        setLocationShareMessage(
            `No GPS location has been shared${orderNote}. Ask the driver to accept the order and start location sharing in the driver portal.`,
            "error"
        );
    }
    $("#orderMap").scrollIntoView({ behavior: "smooth", block: "center" });
}
async function refreshLiveOrderStatuses() {
    orders = await api("/api/orders");
    updateTrackingOutageNotices(orders);
    renderRecentOrdersPreview(orders);
    if ($("#orders").classList.contains("active")) {
        const q = $("#orderSearch").value.toLowerCase();
        $("#ordersTable").innerHTML = trackedOrdersHtml(
            orders.filter(order =>
                [order.id, order.customer, order.item, order.city, order.driver_phone, order.status]
                    .some(value => String(value).toLowerCase().includes(q))
            )
        );
        await renderOrderMap();
    }
}
function orderLocation(order) {
    const destination = cityCoordinates[String(order.city).trim().toLowerCase()];
    if (!destination) return null;
    const progress = { Processing: 0, "In Transit": 0.55, Delivered: 1, Cancelled: 0.2 }[order.status] ?? 0;
    return {
        destination,
        current: [
            dispatchHub.coordinates[0] + (destination[0] - dispatchHub.coordinates[0]) * progress,
            dispatchHub.coordinates[1] + (destination[1] - dispatchHub.coordinates[1]) * progress
        ]
    };
}
async function renderOrderMap() {
    const picker = $("#mapOrderSelect"), progressCard = $("#orderProgress"), legacyStatus = $("#mapStatus");
    if (!picker || (!progressCard && !legacyStatus)) return;
    const showProgress = (html, text) => {
        if (progressCard) progressCard.innerHTML = html;
        if (legacyStatus) legacyStatus.textContent = text;
    };
    const selectedId = picker.value;
    picker.innerHTML = orders.map(order =>
        `<option value="${esc(order.id)}">${esc(order.id)} · ${esc(order.customer)} (${esc(order.city)})</option>`
    ).join("");
    if (!orders.length) {
        $("#completeOrder").disabled = true;
        showProgress("<strong>No order to track yet.</strong><span>Create an order to see its delivery progress.</span>", "Create an order to see its delivery progress.");
        if (orderMap) {
            orderMarkersLayer.clearLayers();
            orderRouteLayer.clearLayers();
        }
        return;
    }
    if (orders.some(order => order.id === selectedId)) picker.value = selectedId;
    const order = orders.find(item => item.id === picker.value) || orders[0];
    const terminalOrder = order.status === "Delivered" || order.status === "Cancelled";
    const completeButton = $("#completeOrder");
    if (completeButton) {
        completeButton.disabled = terminalOrder || completingOrderId === order.id;
        completeButton.textContent = completingOrderId === order.id
            ? "Completing…"
            : order.status === "Delivered" ? "Order completed"
                : order.status === "Cancelled" ? "Order cancelled" : "Mark order completed";
    }
    if (order.tracking_available === false) {
        showProgress(
            `<strong>Order status unavailable</strong><span>The tracking provider is offline. The order status will return when self-healing restores the connection.</span>`,
            `${order.id} · Tracking unavailable`
        );
        if (orderMap) {
            orderMarkersLayer.clearLayers();
            orderRouteLayer.clearLayers();
        }
        return;
    }
    const renderSequence = ++mapRenderSequence;
    let sharedLocation = null, locationError = "";
    try {
        sharedLocation = await api(`/api/orders/${encodeURIComponent(order.id)}/location`);
    } catch (error) {
        locationError = error.message;
    }
    if (renderSequence !== mapRenderSequence || picker.value !== order.id) return;
    const estimatedLocation = orderLocation(order);
    const location = sharedLocation?.available
        ? {
            destination: estimatedLocation?.destination,
            current: [sharedLocation.latitude, sharedLocation.longitude],
            live: !sharedLocation.stale && !terminalOrder,
            stale: sharedLocation.stale,
            final: terminalOrder,
            updatedAt: sharedLocation.updated_at,
            ageSeconds: sharedLocation.age_seconds
        }
        : estimatedLocation ? { ...estimatedLocation, live: false, stale: false } : null;
    if (location?.live) {
        const lastUpdate = formatTime(location.updatedAt);
        const summary = `${order.id} · ${order.customer} · LIVE GPS · Updated ${lastUpdate}`;
        showProgress(`
            <div class="order-progress-summary">
                <span class="order-progress-label">LIVE GPS LOCATION</span>
                <strong>Driver's phone is reporting its current location</strong>
                <small>${esc(order.id)} · ${esc(order.customer)} · Last update: ${esc(lastUpdate)}</small>
            </div>
            <div class="delivery-progress">
                <div class="delivery-progress-track"><span style="width:${order.status === "Delivered" ? 100 : order.status === "In Transit" ? 55 : 8}%"></span></div>
                ${["Jaipur dispatch", "In transit", esc(order.city)].map((label, index) =>
                    `<div class="delivery-progress-step ${index < (order.status === "Delivered" ? 2 : order.status === "In Transit" ? 1 : 0) ? "complete" : ""} ${index === (order.status === "Delivered" ? 2 : order.status === "In Transit" ? 1 : 0) ? "current" : ""}">
                        <i>${index < (order.status === "Delivered" ? 2 : order.status === "In Transit" ? 1 : 0) ? "✓" : index + 1}</i><span>${label}</span>
                    </div>`
                ).join("")}
            </div>`, summary);
    } else if (location?.stale) {
        const lastUpdate = formatTime(location.updatedAt);
        showProgress(`<strong>Last GPS location (out of date)</strong><span>Driver's phone last shared its location at ${esc(lastUpdate)}. Waiting for a new GPS update.</span>`, `${order.id} · Last GPS update ${location.ageSeconds} seconds ago`);
    } else if (location?.final) {
        const lastUpdate = formatTime(location.updatedAt);
        showProgress(`<strong>Last shared driver location</strong><span>GPS sharing stopped when this order was ${esc(order.status.toLowerCase())}. Last location update: ${esc(lastUpdate)}.</span>`, `${order.id} · Last driver location ${lastUpdate}`);
    } else if (sharedLocation?.available) {
        showProgress(`<strong>${esc(order.id)} · ${esc(order.status)}</strong><span>Waiting for a fresh GPS update from the driver's phone.</span>`, `${order.id} · Waiting for driver's GPS update`);
    } else if (location && !locationError) {
        showProgress(`
            <div class="order-progress-summary">
                <span class="order-progress-label">LIVE GPS NOT SHARED</span>
                <strong>Waiting for the driver to share this order's location</strong>
                <small>${esc(order.id)} · ${esc(order.customer)} · The pin below is not live.</small>
            </div>`, `${order.id} · No live GPS location has been shared`);
    } else if (locationError) {
        showProgress(`<strong>${esc(order.id)} · ${esc(order.status)}</strong><span>Live location service could not be reached: ${esc(locationError)}</span>`, `${order.id} · Live location service error`);
    }
    if (!location) {
        const message = `${order.id} · ${order.status} · ${order.city} is not a supported map location.`;
        if (!sharedLocation?.available && !locationError) {
            showProgress(`<strong>${esc(order.id)} · ${esc(order.status)}</strong><span>${esc(order.city)} is not in the supported map locations. A live GPS pin will appear as soon as the driver shares this order's location.</span>`, message);
        }
    }
    if (!window.L) {
        const showGpsPin = Boolean(location?.live || location?.stale || location?.final);
        const point = showGpsPin ? location.current : dispatchHub.coordinates;
        const [lat, lon] = point;
        const delta = 0.12;
        const bounds = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
        const fallback = document.createElement("iframe");
        fallback.className = "map-fallback";
        fallback.title = location?.live || location?.stale || location?.final
            ? `Last GPS location for order ${order.id}`
            : "Map awaiting live GPS from the delivery driver";
        fallback.loading = "lazy";
        fallback.src = `https://www.openstreetmap.org/export/embed.html?bbox=${bounds}&layer=mapnik${showGpsPin ? `&marker=${lat},${lon}` : ""}`;
        const mapContainer = $("#orderMap");
        mapContainer.replaceChildren(fallback);
        mapContainer.setAttribute("role", "region");
        return;
    }
    if (!orderMap) {
        $("#orderMap").replaceChildren();
        $("#orderMap").setAttribute("role", "img");
        orderMap = L.map("orderMap").setView([23.5, 78.5], 5);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(orderMap);
        orderRouteLayer = L.layerGroup().addTo(orderMap);
        orderMarkersLayer = L.layerGroup().addTo(orderMap);
    }
    orderMap.invalidateSize();
    orderRouteLayer.clearLayers();
    orderMarkersLayer.clearLayers();
    const route = location?.destination ? [dispatchHub.coordinates, location.destination] : [dispatchHub.coordinates];
    if (location?.destination) {
        L.polyline(route, { color: "#98a3b7", weight: 4, dashArray: "8 8" }).addTo(orderRouteLayer);
        L.marker(location.destination).bindPopup(`Delivery destination: ${esc(order.city)}`).addTo(orderMarkersLayer);
    }
    if (location?.live || location?.stale || location?.final) {
        L.polyline([dispatchHub.coordinates, location.current], {
            color: location.stale || location.final ? "#98a3b7" : "#4263eb",
            weight: 5,
            dashArray: location.stale || location.final ? "6 6" : undefined
        }).addTo(orderRouteLayer);
    }
    if (!location?.live && !location?.stale) {
        L.marker(dispatchHub.coordinates).bindPopup("Demo dispatch hub; not the parcel's live location").addTo(orderMarkersLayer);
    }
    if (location?.current && (location.live || location.stale || location.final)) {
        L.circleMarker(location.current, {
            radius: 11, color: "#ffffff", weight: 3,
            fillColor: location.live ? "#19a974" : "#8992a6", fillOpacity: 1
        }).bindPopup(`${esc(order.id)} · ${location.live ? "Live GPS" : "Last known GPS"} · ${esc(formatTime(location.updatedAt))}`).addTo(orderMarkersLayer);
    }
    const boundsPoints = [...route, ...(location?.current ? [location.current] : [])];
    orderMap.fitBounds(L.latLngBounds(boundsPoints).pad(0.25));
}

function setLocationShareMessage(text, state = "") {
    const message = $("#locationShareMessage");
    message.textContent = text;
    message.className = `message ${state}`.trim();
}

async function loadIncidents() { const incidents = await api("/api/incidents"); const html = incidents.map(i => `<div class="incident"><div><b>${esc(i.id)} · ${esc(i.component)}</b><small>${esc(i.problem)}<br>Mechanism: ${esc(i.mechanism || "—")} · Attempts: ${Number(i.attempts) || 1}<br>Detected: ${esc(formatTime(i.detected_at))}<br>Diagnosed: ${esc(formatTime(i.diagnosed_at))}<br>Action taken: ${esc(formatTime(i.action_taken_at))}<br>Recovered: ${esc(formatTime(i.recovered_at))}<br>Detection: ${i.detection_ms == null ? "—" : `${Number(i.detection_ms)} ms`} · Recovery: ${i.recovery_ms == null ? "—" : `${Number(i.recovery_ms)} ms`}</small></div><div class="right">${badge(i.stage)}<small>${esc(i.action)}</small></div></div>`).join("") || "<p>No incidents recorded.</p>"; $("#incidentsList").innerHTML = html; $("#chaosIncidentsList").innerHTML = html }
async function loadAnalytics() { const d = await api("/api/analytics"); $("#analyticsRate").textContent = d.recovery_success_rate + "%"; $("#analyticsIncidents").textContent = d.total_incidents; $("#mttd").innerHTML = `${Number(d.mttd_seconds).toFixed(3)} <em>sec</em>`; $("#mttr").innerHTML = `${Number(d.mttr_seconds).toFixed(3)} <em>sec</em>`; const entries = Object.entries(d.status_counts); const max = Math.max(1, ...entries.map(x => x[1])); $("#statusChart").innerHTML = entries.map(([s, n]) => `<div class="bar-row"><b>${esc(s)}</b><div class="bar-track"><div class="bar-fill" style="width:${n / max * 100}%"></div></div><strong>${n}</strong></div>`).join("") || "<p>No order data yet.</p>" }
async function refresh() { try { await Promise.all([loadDashboard(), loadHealth(), loadIncidents(), loadAnalytics()]) } catch (e) { toast("API error: " + e.message) } }
function showPage(page) { $$(".page").forEach(p => p.classList.toggle("active", p.id === page)); $$(".nav").forEach(n => n.classList.toggle("active", n.dataset.page === page)); $("#pageTitle").textContent = titles[page] || "Dashboard"; if (page === "orders") return loadOrders(); if (page === "incidents" || page === "chaos") loadIncidents(); if (page === "analytics") loadAnalytics(); if (page === "dashboard") loadHealth() }
async function waitForIncident(id) { for (let attempt = 0; attempt < 20; attempt++) { const incidents = await api("/api/incidents"); const incident = incidents.find(i => i.id === id); if (incident?.stage === "Recovered") return incident; await new Promise(resolve => setTimeout(resolve, 100)) } const incidents = await api("/api/incidents"); return incidents.find(i => i.id === id) }
function renderComparison(result, incident) { const container = $("#chaosComparison"); const detection = incident?.detection_ms == null ? "pending" : `${Number(incident.detection_ms)} ms`; const recovery = incident?.recovery_ms == null ? "pending" : `${Number(incident.recovery_ms)} ms`; container.innerHTML = `<h3>Recovery impact</h3><div class="comparison-grid"><section><b>Without healing</b><p>${esc(result.without_healing || "Failure remains unresolved.")}</p></section><section><b>With healing</b><p>${esc(result.with_healing || result.message)}</p><small>Measured detection: ${detection} · recovery: ${recovery}</small></section></div>`; container.hidden = false }
$$(".nav").forEach(n => n.addEventListener("click", () => showPage(n.dataset.page)));
$$("[data-goto]").forEach(b => b.addEventListener("click", async () => {
    try {
        await showPage(b.dataset.goto);
        const target = b.dataset.gotoTarget && $(`#${b.dataset.gotoTarget}`);
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
            target.focus({ preventScroll: true });
        }
    } catch (error) {
        toast(`Could not open ${titles[b.dataset.goto] || "page"}: ${error.message}`);
    }
}));
$("#orderForm").addEventListener("submit", async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const message = $("#orderMessage");
    try {
        const result = await api("/api/orders", { method: "POST", body: JSON.stringify(data) });
        message.className = "message";
        const driverPortalUrl = new URL(result.driver_portal_path, window.location.origin).href;
        const orderMessage = [
            "New delivery order assigned",
            `Order: ${result.id}`,
            `Customer: ${data.customer}`,
            `Item: ${data.item}`,
            `Amount: ${Number(data.amount).toLocaleString("en-IN", { style: "currency", currency: "INR" })}`,
            `Delivery city: ${data.city}`,
            `Accept and track this order: ${driverPortalUrl}`
        ].join("\n");
        message.replaceChildren(
            document.createTextNode(`${result.message}: ${result.id}. Message the driver at ${result.driver_phone}:`)
        );
        const messageBox = document.createElement("textarea");
        messageBox.className = "order-message-box";
        messageBox.setAttribute("aria-label", "Order details message for the driver");
        messageBox.rows = 7;
        messageBox.value = orderMessage;
        const messageActions = document.createElement("div");
        messageActions.className = "order-message-actions";
        const smsLink = document.createElement("a");
        smsLink.className = "btn primary";
        smsLink.href = `sms:${result.driver_phone}?body=${encodeURIComponent(orderMessage)}`;
        smsLink.textContent = "Open SMS";
        const whatsappLink = document.createElement("a");
        whatsappLink.className = "btn";
        whatsappLink.href = `https://wa.me/${result.driver_phone.replace(/\D/g, "")}?text=${encodeURIComponent(orderMessage)}`;
        whatsappLink.target = "_blank";
        whatsappLink.rel = "noopener noreferrer";
        whatsappLink.textContent = "Open WhatsApp";
        if (!result.driver_phone.startsWith("+")) {
            whatsappLink.setAttribute("aria-disabled", "true");
            whatsappLink.title = "WhatsApp requires the driver's phone number with its international country code.";
            whatsappLink.addEventListener("click", event => event.preventDefault());
        }
        messageBox.addEventListener("input", () => {
            const encodedMessage = encodeURIComponent(messageBox.value);
            smsLink.href = `sms:${result.driver_phone}?body=${encodedMessage}`;
            whatsappLink.href = `https://wa.me/${result.driver_phone.replace(/\D/g, "")}?text=${encodedMessage}`;
        });
        const messageHint = document.createElement("small");
        messageHint.className = "order-message-hint";
        messageHint.textContent = "Review the draft in your messaging app and tap Send. WhatsApp requires an international phone number with a country code.";
        messageActions.append(smsLink, whatsappLink);
        const driverLink = document.createElement("a");
        driverLink.href = new URL(result.driver_portal_path, window.location.origin).href;
        driverLink.textContent = "Open driver portal";
        driverLink.target = "_blank";
        driverLink.rel = "noopener noreferrer";
        const copyLink = document.createElement("button");
        copyLink.type = "button";
        copyLink.className = "btn";
        copyLink.textContent = "Copy driver link";
        copyLink.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(driverPortalUrl);
                copyLink.textContent = "Copied";
            } catch {
                copyLink.textContent = "Copy failed; copy the portal URL from the address bar";
                copyLink.classList.add("error");
            }
        });
        message.append(messageBox, messageActions, messageHint,
            document.createTextNode("Driver portal: "), driverLink,
            document.createTextNode(" "), copyLink);
        e.target.reset();
        await refresh();
        showPage("orders");
    } catch (error) {
        message.textContent = error.message;
        message.className = "message error";
    }
});
$("#orderSearch").addEventListener("input", loadOrders);
$("#mapOrderSelect").addEventListener("change", () => {
    renderOrderMap();
});
$("#completeOrder").addEventListener("click", async () => {
    const orderId = $("#mapOrderSelect").value;
    const order = orders.find(item => item.id === orderId);
    if (!order || order.status === "Delivered" || order.status === "Cancelled") return;
    completingOrderId = orderId;
    $("#completeOrder").disabled = true;
    $("#completeOrder").textContent = "Completing…";
    try {
        const result = await api(`/api/orders/${encodeURIComponent(orderId)}/complete`, {
            method: "POST"
        });
        setLocationShareMessage(result.message, "live");
        try {
            await Promise.all([loadOrders(), loadDashboard(), loadAnalytics()]);
        } catch (error) {
            toast(`Order completed, but dashboard refresh failed: ${error.message}`);
        }
    } catch (error) {
        setLocationShareMessage(error.message, "error");
    } finally {
        completingOrderId = null;
        const selectedOrder = orders.find(item => item.id === $("#mapOrderSelect").value);
        const isTerminal = selectedOrder &&
            (selectedOrder.status === "Delivered" || selectedOrder.status === "Cancelled");
        $("#completeOrder").disabled = Boolean(isTerminal);
        $("#completeOrder").textContent = !selectedOrder ? "Mark order completed"
            : selectedOrder.status === "Delivered" ? "Order completed"
                : selectedOrder.status === "Cancelled" ? "Order cancelled" : "Mark order completed";
    }
});
$$(".problem-choice").forEach(button => button.addEventListener("click", async () => {
    if (autoHealRunning) return;
    const problem = button.dataset.problem;
    if (selectedAutoHealProblems.has(problem)) {
        if (preInjectedAutoHealProblems.has(problem)) {
            toast(problem === "cleanup_orders"
                ? "Order data is awaiting recovery. Click Detect & Auto-Heal to restore it."
                : problem === "recent_orders"
                    ? "Recent orders are unavailable. Click Detect & Auto-Heal to restore the order view."
                    : problem === "network_failure"
                        ? "Network connectivity is unavailable. Click Detect & Auto-Heal to restore tracking."
                    : "Tracking outage is active. Click Detect & Auto-Heal to restore order tracking.");
            return;
        }
        selectedAutoHealProblems.delete(problem);
    } else {
        if (problem === "cleanup_orders"
                ? selectedAutoHealProblems.size > 0
                : selectedAutoHealProblems.has("cleanup_orders")) {
            toast("Clean up data must be selected by itself.");
            return;
        }
        selectedAutoHealProblems.add(problem);
    }
    $$(".problem-choice").forEach(choice => {
        choice.setAttribute("aria-pressed", String(selectedAutoHealProblems.has(choice.dataset.problem)));
    });
    if (["tracking_outage", "recent_orders", "cleanup_orders", "network_failure"].includes(problem)
            && selectedAutoHealProblems.has(problem)) {
        const recentOrdersProblem = problem === "recent_orders";
        const cleanupOrdersProblem = problem === "cleanup_orders";
        const networkFailureProblem = problem === "network_failure";
        const problemLabel = cleanupOrdersProblem ? "Order data"
            : recentOrdersProblem ? "Recent orders"
                : networkFailureProblem ? "Network connectivity" : "Tracking outage";
        autoHealStepIndex = 0;
        button.disabled = true;
        $("#autoHeal").disabled = true;
        setAutoHealProgress(
            "detecting",
            cleanupOrdersProblem ? "ORDER DATA CLEANED UP"
                : recentOrdersProblem ? "RECENT ORDERS UNAVAILABLE"
                    : networkFailureProblem ? "NETWORK FAILURE ACTIVE" : "TRACKING OUTAGE ACTIVE",
            cleanupOrdersProblem
                ? "All order rows were removed after saving a persistent snapshot. Click Detect & Auto-Heal to restore them."
                : recentOrdersProblem
                    ? "The dashboard's recent orders preview is unavailable. Click Detect & Auto-Heal to restore it."
                    : networkFailureProblem
                        ? "Network connectivity is unavailable and live order tracking is interrupted. Click Detect & Auto-Heal to restore the connection."
                        : "Order status is unavailable. Click Detect & Auto-Heal to restore the tracking provider."
        );
        try {
            const injected = await api("/api/auto-heal/problem", {
                method: "POST",
                body: JSON.stringify({ problem })
            });
            preInjectedAutoHealProblems.set(problem, injected);
            if (networkFailureProblem) {
                $("#autoHeal").textContent = "Heal Network";
            }
            toast(cleanupOrdersProblem
                ? "All order rows were removed; a persistent recovery snapshot is ready."
                : recentOrdersProblem
                    ? "Recent orders hidden; click Detect & Auto-Heal to restore the order view."
                    : networkFailureProblem
                        ? "Network failure simulated; live order tracking is unavailable."
                        : "Tracking outage simulated; order statuses are unavailable");
        } catch (error) {
            selectedAutoHealProblems.delete(problem);
            button.setAttribute("aria-pressed", "false");
            setAutoHealProgress(
                "failed",
                cleanupOrdersProblem ? "COULD NOT CLEAN UP ORDER DATA"
                    : recentOrdersProblem ? "COULD NOT HIDE RECENT ORDERS"
                        : networkFailureProblem ? "COULD NOT SIMULATE NETWORK FAILURE"
                            : "COULD NOT SIMULATE TRACKING OUTAGE",
                error.message
            );
            toast(error.message);
        } finally {
            button.disabled = false;
            $("#autoHeal").disabled = false;
        }
        if (preInjectedAutoHealProblems.has(problem)) {
            try {
                if (recentOrdersProblem) {
                    await Promise.all([loadDashboard(), loadHealth()]);
                } else {
                    await Promise.all([loadDashboard(), loadOrders(), loadHealth()]);
                }
            } catch (error) {
                toast(`${problemLabel} fault is active, but the view refresh failed: ${error.message}`);
            }
        }
    }
    autoHealStepIndex = 0;
    const selectedNames = $$(".problem-choice")
        .filter(choice => selectedAutoHealProblems.has(choice.dataset.problem))
        .map(choice => choice.querySelector("strong").textContent);
    activeAutoHealProblems = $$(".problem-choice")
        .filter(choice => selectedAutoHealProblems.has(choice.dataset.problem))
        .map(choice => preInjectedAutoHealProblems.get(choice.dataset.problem) || ({
            problem: choice.dataset.problem,
            incident_id: choice.dataset.problem === "driver_location" ? "" : null,
            name: choice.querySelector("strong").textContent,
            description: choice.querySelector("strong").textContent,
            issue: choice.querySelector("small").textContent,
            component: "Waiting for detection"
        }));
    renderProblemProgress(preInjectedAutoHealProblems.size ? "detecting" : "selected");
    if (selectedNames.length) {
        setAutoHealProgress(
            preInjectedAutoHealProblems.size ? "detecting" : "running",
            `${selectedNames.length} PROBLEM${selectedNames.length === 1 ? "" : "S"} SELECTED`,
            preInjectedAutoHealProblems.size
                ? `${selectedNames.join(", ")}. The selected problem is active; click Detect & Auto-Heal to restore it.`
                : `${selectedNames.join(", ")}. Click Detect & Auto-Heal to inject and repair ${selectedNames.length === 1 ? "it" : "them"}.`
        );
    } else {
        setAutoHealProgress(
            "running",
            "READY TO RUN",
            "Select one or more problems, or run a health check without injecting a problem."
        );
    }
}));
$("#autoHeal").addEventListener("click", async () => {
    const button = $("#autoHeal");
    const buttonLabel = button.textContent;
    showPage("dashboard");
    button.disabled = true;
    autoHealRunning = true;
    $$(".problem-choice").forEach(choice => { choice.disabled = true; });
    autoHealStepIndex = 0;
    const driverLocationSelected = selectedAutoHealProblems.has("driver_location");
    const selectedProblems = [...selectedAutoHealProblems]
        .filter(problem =>
            problem !== "driver_location" && !preInjectedAutoHealProblems.has(problem)
        );
    const selectedProblemNames = $$(".problem-choice")
        .filter(choice => selectedAutoHealProblems.has(choice.dataset.problem)
            && choice.dataset.problem !== "driver_location"
            && !preInjectedAutoHealProblems.has(choice.dataset.problem))
        .map(choice => choice.querySelector("strong").textContent);
    const allSelectedProblemNames = $$(".problem-choice")
        .filter(choice => selectedAutoHealProblems.has(choice.dataset.problem))
        .map(choice => choice.querySelector("strong").textContent);
    const trackingOutageActive = preInjectedAutoHealProblems.has("tracking_outage");
    const networkFailureActive = preInjectedAutoHealProblems.has("network_failure");
    const cleanupOrdersActive = preInjectedAutoHealProblems.has("cleanup_orders");
    setAutoHealProgress(
        "running",
        selectedProblems.length ? "CREATING SELECTED PROBLEMS"
            : cleanupOrdersActive ? "RESTORING ORDER DATA"
                : networkFailureActive ? "RESTORING CONNECTIVITY"
                    : trackingOutageActive ? "RESTORING TRACKING"
                : driverLocationSelected ? "CHECKING DRIVER GPS" : "STARTING LIVE HEALTH SCAN",
        selectedProblems.length
            ? `Injecting ${selectedProblemNames.join(", ")} for live recovery.`
            : cleanupOrdersActive
                ? "Restoring every order from its persistent recovery snapshot."
                : networkFailureActive
                    ? "Restoring network connectivity and verifying live order tracking."
                : trackingOutageActive
                ? "The tracking outage is active and orders are unavailable. Detect & Auto-Heal is restoring the provider."
                : driverLocationSelected
                    ? `${allSelectedProblemNames.join(", ")}. Checking saved driver GPS and refreshing the Order Tracking map.`
                    : "Checking app components and order data."
    );
    const healthPolling = setInterval(() => {
        loadHealth().catch(error => {
            if (autoHealRunning) {
                setAutoHealProgress("failed", "HEALTH CHECK FAILED", `Could not check the error while healing: ${error.message}`);
            }
        });
    }, 100);
    try {
        if (selectedProblems.length) {
            const injection = await api("/api/auto-heal/problems", {
                method: "POST",
                body: JSON.stringify({ problems: selectedProblems })
            });
            activeAutoHealProblems = [
                ...preInjectedAutoHealProblems.values(),
                ...injection.problems
            ];
            if (driverLocationSelected) {
                activeAutoHealProblems.push({
                    problem: "driver_location",
                    incident_id: "",
                    description: "Driver's location not showing",
                    issue: "Driver's live location isn't showing in Order Tracking.",
                    component: "Order Tracking map",
                    repair: "Find the latest GPS update from the driver's phone and refresh the map."
                });
            }
            renderProblemProgress("detecting");
        }
        const result = await api("/api/auto-heal", { method: "POST" });
        autoHealRunning = false;
        const recovered = [...(result.recovered || [])];
        const unresolved = [];
        const driverLocation = driverLocationSelected
            ? await findLatestDriverLocation()
            : null;
        if (driverLocationSelected && driverLocation?.live) {
            recovered.push({
                incident_id: "",
                component: "Order Tracking map",
                problem: "Driver's live location was not showing",
                diagnosis: `A recent GPS update from the driver's phone was found for order ${driverLocation.order.id}.`,
                action: `Refreshed the Order Tracking map with the driver's actual GPS location. Last update: ${formatTime(driverLocation.location.updated_at)}.`,
                mechanism: "Refresh from saved driver GPS"
            });
        } else if (driverLocationSelected) {
            unresolved.push({
                incident_id: "",
                component: "Order Tracking map",
                problem: "Driver's live location is not available",
                diagnosis: driverLocation
                    ? `Order ${driverLocation.order.id} has only a stale or final saved GPS point; it is not the driver's current location.`
                    : "No GPS coordinates have been shared by a driver yet.",
                action: "Ask the driver to open the private portal, accept the active order, tap Start sharing location, and allow GPS permission. The map updates when the phone sends a location."
            });
        }
        if (!activeAutoHealProblems.length && recovered.length) {
            activeAutoHealProblems = recovered.map(item => ({
                incident_id: item.incident_id,
                description: item.problem || item.component,
                issue: item.diagnosis || item.problem || "Issue detected during the live health scan.",
                component: item.component,
                repair: item.action
            }));
        }
        renderProblemProgress(unresolved.length ? "failed" : "healed", recovered, unresolved);
        const incident = recovered[0]?.incident_id || result.incident_id;
        if (!recovered.length && !driverLocationSelected) {
            const healthyStages = [
                ["detecting", "DETECTING", "Checking live component health and order data."],
                ["diagnosing", "DIAGNOSING", "The health scan found no active issues."],
                ["healing", "HEAL CHECK", "Confirming every monitored component is healthy."],
                ["verifying", "VERIFYING", "Checking the final health results."]
            ];
            for (const [stage, title, detail] of healthyStages) {
                setAutoHealProgress(stage, title, detail);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        setAutoHealProgress(
            unresolved.length ? "failed" : "healed",
            unresolved.length ? "DRIVER GPS NEEDS ATTENTION"
                : recovered.length ? "HEALING COMPLETE" : "SYSTEM HEALTHY",
            unresolved.length
                ? unresolved.map(item => item.action).join(" ")
                : `${result.message}${incident ? ` Incident ${incident}.` : ""}`
        );
        toast(unresolved.length ? "Driver GPS needs attention" : "Auto-heal check completed");
        selectedAutoHealProblems.clear();
        preInjectedAutoHealProblems.clear();
        $$(".problem-choice").forEach(choice => {
            choice.disabled = false;
            choice.setAttribute("aria-pressed", "false");
        });
        try {
            await refresh();
            if (trackingOutageActive || networkFailureActive || cleanupOrdersActive) {
                await loadOrders();
            }
        } catch (refreshError) {
            toast(`Health check completed, but dashboard refresh failed: ${refreshError.message}`);
        }
        if (driverLocationSelected) {
            await openDriverLocationTracking(driverLocation);
        }
        if (recovered.length && !driverLocationSelected) {
            const recoveredIds = new Set(recovered.map(item => item.incident_id));
            const solvedProblem = $$(".problem-progress-card").find(card =>
                recoveredIds.has(card.dataset.incidentId)
            );
            const recoveryTarget = solvedProblem || $("#problemProgress");
            recoveryTarget?.scrollIntoView({ behavior: "smooth", block: "center" });
            recoveryTarget?.focus({ preventScroll: true });
        }
        showHealingResult(
            recovered,
            driverLocationSelected && driverLocation?.live
                ? `${result.message} Driver GPS was found and the Order Tracking map was refreshed.`
                : driverLocationSelected
                    ? `${result.message} No current live GPS update is available.`
                    : result.message,
            unresolved
        );
    } catch (error) {
        autoHealRunning = false;
        renderProblemProgress("failed");
        setAutoHealProgress("failed", "HEALING FAILED", error.message);
        if (networkFailureActive) {
            loadHealth().catch(healthError =>
                toast(`Network recovery failed and health refresh failed: ${healthError.message}`)
            );
        }
    } finally {
        clearInterval(healthPolling);
        autoHealRunning = false;
        button.disabled = false;
        button.textContent = networkFailureActive
                && preInjectedAutoHealProblems.has("network_failure")
            ? "Heal Network" : buttonLabel === "Heal Network"
                ? "Detect & Auto-Heal" : buttonLabel;
        $$(".problem-choice").forEach(choice => { choice.disabled = false; });
    }
});
$("#networkAutoHeal").addEventListener("click", () => $("#autoHeal").click());
$("#runChaos").addEventListener("click", async () => { const button = $("#runChaos"), message = $("#chaosMessage"); button.disabled = true; message.className = "message"; message.textContent = "Injecting failure and running recovery…"; try { const d = await api("/api/chaos", { method: "POST", body: JSON.stringify({ failure: $("#chaosScenario").value }) }); const incident = await waitForIncident(d.incident_id); message.textContent = `${d.message}. Incident ${d.incident_id}; ${d.mechanism || "watchdog recovery"}; ${incident?.stage || d.stage}.`; renderComparison(d, incident); await refresh(); toast("Healing action recorded") } catch (e) { message.textContent = e.message; message.className = "message error" } finally { button.disabled = false } });
$("#resetChaos").addEventListener("click", async () => {
    try {
        const d = await api("/api/chaos/reset", { method: "POST" });
        $("#chaosMessage").textContent = d.message;
        preInjectedAutoHealProblems.clear();
        selectedAutoHealProblems.clear();
        activeAutoHealProblems = [];
        $$(".problem-choice").forEach(choice => choice.setAttribute("aria-pressed", "false"));
        renderProblemProgress("selected");
        await refresh();
    } catch (e) {
        $("#chaosMessage").textContent = e.message;
        $("#chaosMessage").className = "message error";
    }
});
$("#closeHealingResult").addEventListener("click", () => $("#healingResultDialog").close());
$("#healingResultDialog").addEventListener("click", event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
});
refresh();
setInterval(() => {
    refreshLiveOrderStatuses().catch(error => toast(`Order status refresh failed: ${error.message}`));
}, 2000);
setInterval(async () => { try { await loadHealth(); await loadDashboard(); if ($("#orders").classList.contains("active")) await loadOrders(); if ($("#chaos").classList.contains("active") || $("#incidents").classList.contains("active")) await loadIncidents() } catch (e) { toast("Refresh failed: " + e.message) } }, 10000);
