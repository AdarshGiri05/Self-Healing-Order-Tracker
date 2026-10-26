# Self-Healing Order Tracker

A small order-management app with an operational health dashboard, persisted incident timeline, and a controlled chaos lab.

## Run on Windows

1. Install Python 3.10+ if it is not installed.
2. Open Command Prompt in this folder.
3. Install the app dependencies:
   ```bat
   py -m pip install -r requirements.txt
   ```
4. Start the app:
   ```bat
   py app.py
   ```
5. Open `http://127.0.0.1:5000`.

The app runs with Waitress, a production WSGI server, instead of Flask's development server. SQLite and sample orders are initialized automatically in `tracker.db`. Stop the app with `Ctrl+C`.

When creating an order, enter the assigned driver's phone number. The confirmation prepares an editable message containing the order details and private driver-portal link, with buttons to open a pre-filled SMS or WhatsApp draft. Review the draft and tap **Send** in your messaging app; the website does not send messages automatically. WhatsApp requires the phone number to include its international country code. The in-app portal refreshes every three seconds while open and shows newly assigned orders with an **Accept order** button.

After accepting an order, the driver allows browser location access to start GPS sharing. The latest location is stored with the order and refreshed on the Order Tracking map every few seconds. Sharing requires HTTPS (or localhost for same-device testing), an internet connection, and the driver's permission. The driver's first GPS update moves an order from **Processing** to **In Transit**. Tap **Mark delivered** in the driver portal when finished; this stops location sharing and records the order as delivered. The map does not invent a live location when GPS has not been shared.

Order status is driver-controlled. An accepted order remains active until the assigned driver marks it delivered. Location updates are saved in SQLite and reflected in the order table, dashboard, and tracking view. The order page polls for changes every two seconds.

For a separate driver's phone, the app must be reachable through an HTTPS URL; the default Waitress server listens only on `127.0.0.1`, so use an HTTPS reverse proxy that forwards to the local app. Open the manager page through that same HTTPS URL when creating orders so the driver link uses a reachable host. Browser GPS is intentionally unavailable over plain HTTP on a phone or other LAN device.

## Working self-healing mechanisms

Choose a failure in **Chaos Testing Lab**, then click **Inject failure & heal**:

1. **Watchdog restart** — stops the simulated order worker; the background heartbeat watchdog restarts it and records recovery.
2. **Exponential backoff** — injects transient provider timeouts and retries with 100 ms / 200 ms delays before succeeding.
3. **Circuit breaker** — makes the tracking provider unavailable; after three failed calls the breaker opens and rejects further provider calls for its cool-down period.
4. **Cached fallback** — keeps order tracking available from the last-known order status when the tracking provider is unavailable.
5. **Data repair** — writes an invalid status, detects it against the allowed status lifecycle, and restores the pre-fault snapshot.

These chaos scenarios are deliberately **controlled in-process simulations**: they do not kill the Flask process or disable a real network service. In particular, the watchdog protects the simulated worker component, not the Flask host process itself. A process-level deployment watchdog (such as a service manager or container restart policy) is needed to restart the whole app after a host-process crash.

The dashboard polls live component health. The chaos lab shows the expected unhealed outcome beside the observed healing action. Incident records store `Detected`, `Diagnosed`, `Action Taken`, and `Recovered` timestamps in SQLite, as well as retry counts and measured detection/recovery durations. Structured JSON lifecycle events are also emitted to the application log. Analytics calculate MTTD and MTTR from recovered incident records rather than fixed demo values.

Use **Detect & Auto-Heal** on the dashboard to scan the app's current health and order data, diagnose supported issues, apply in-app repairs, and verify the results. Selecting **Tracking outage** immediately simulates a tracking-provider failure and displays **Unavailable** for order tracking statuses; click **Detect & Auto-Heal** to restore the provider and return the normal order statuses. Selecting **Network fail** simulates lost connectivity, marks live tracking unavailable, and covers the website with a connection-lost screen. Click **Self-Heal Network** on that screen to restore connectivity and verify order tracking. This is an in-app simulation; the Flask process remains available so the recovery action can run. Driver GPS appears on the Order Tracking map after the driver accepts an order and shares location from the driver portal; the app never fabricates a live position or claims missing GPS was recovered. When issues are found, the right-side healing window shows Detect, Diagnose, Heal, and Verify for about 7.5 seconds each (about 30 seconds total). The checks and supported in-app repairs are real; the pacing keeps each step visible. If no issue is found, the health check returns immediately. Supported actions include restoring simulated runtime service flags, clearing stale retry/circuit-breaker state, and repairing invalid order statuses from last-known snapshots. Incident stages and timestamps are saved in the timeline. These are in-process application repairs, not recovery of a real external provider or restart of the Flask process; production infrastructure needs its own provider integration and process supervisor.

Select **Recent orders not showing** to hide the dashboard's recent-orders preview. Click **Detect & Auto-Heal** to restore it. The dashboard preview continues to show only the four newest orders; use **View all orders** to open the full list on the separate Order Tracking page.

Select **Clean up data** to save every order row and its fields in a persistent SQLite recovery snapshot, then remove the order rows from the `orders` table. Driver portal records are left untouched, and new order creation is paused while recovery is pending. Click **Detect & Auto-Heal** to restore the saved orders. The snapshot survives app restarts, and automatic sample-order initialization is suppressed until recovery finishes. This is a destructive simulation; do not use it as a substitute for regular database backups.

Use **Reset simulated services** after the provider-outage scenarios to restore the simulated dependency. Orders, search, status updates, incident history, and analytics remain available as the core application.

## API routes

- `GET /api/dashboard` — order summary and component status
- `GET /api/health` — live green / amber / red component checks
- `POST /api/auto-heal` — scan and repair supported in-app component/order-data faults, then verify recovery; runs through four visible 7.5-second stages when issues are found
- `POST /api/auto-heal/demo` — compatibility alias for `/api/auto-heal`; it no longer injects a fault or adds demo delays
- `GET /api/orders` — list orders
- `POST /api/orders` — create an order
- `GET /driver/<token>` — private driver portal for orders assigned to that driver's phone
- `GET /api/driver/<token>/orders` — list assigned driver orders
- `POST /api/driver/<token>/orders/<order_id>/accept` — accept an assigned order
- `POST /api/driver/<token>/orders/<order_id>/location` — submit the accepted driver's GPS location
- `POST /api/driver/<token>/orders/<order_id>/complete` — mark an accepted driver order as delivered
- `PATCH /api/orders/<order_id>` — update an order status
- `POST /api/orders/<order_id>/complete` — mark an active order as delivered
- `GET /api/orders/auto-progress` — check the automatic order progression state
- `GET /api/orders/<order_id>/location` — latest shared GPS coordinates for an order
- `POST /api/orders/<order_id>/location` — update coordinates from the delivery driver's phone
- `GET /api/orders/<order_id>/tracking` — tracking with cached fallback
- `GET /api/incidents` — recent lifecycle records and measurements
- `GET /api/incidents/<incident_id>/events` — timestamped stage events
- `POST /api/chaos` — inject one of the five supported faults
- `POST /api/chaos/reset` — clear simulated service faults
- `GET /api/analytics` — live recovery measurements and order counts

GPS location updates are stored as the order's most recent coordinates and become stale after 45 seconds without a new update. Driver portal URLs contain a private bearer token: anyone with the link can view assigned orders and act as that driver. Keep these links private and deploy behind HTTPS. The legacy order-ID location endpoints are unauthenticated; do not use real customer data without adding appropriate authentication and authorization.
