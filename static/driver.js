const driverToken = document.body.dataset.driverToken;
const ordersNode = document.querySelector("#driverOrders");
const messageNode = document.querySelector("#driverMessage");
let assignedOrders = [];
let knownOrderIds = null;
let locationWatchId = null;
let lastLocationSentAt = 0;
let locationSendInProgress = false;

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[character]));
}

function setMessage(message, state = "") {
    messageNode.textContent = message;
    messageNode.className = `driver-message ${state}`.trim();
}

async function driverApi(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options
    });
    const body = await response.text();
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        throw Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) throw Error(data.error || `Request failed (HTTP ${response.status}).`);
    return data;
}

function acceptedActiveOrders() {
    return assignedOrders.filter(order =>
        order.driver_accepted_at && ["Processing", "In Transit"].includes(order.status)
    );
}

function renderOrders() {
    if (!assignedOrders.length) {
        ordersNode.innerHTML = "<p>No orders are assigned to this driver yet.</p>";
        return;
    }
    ordersNode.innerHTML = assignedOrders.map(order => {
        const isTerminal = ["Delivered", "Cancelled"].includes(order.status);
        const accepted = Boolean(order.driver_accepted_at);
        const lastLocation = order.location_updated_at
            ? `Last location: ${escapeHtml(new Date(order.location_updated_at).toLocaleString())}`
            : "No location shared yet.";
        let action = "";
        if (!accepted && !isTerminal) {
            action = `<button class="btn primary" data-action="accept" data-order-id="${escapeHtml(order.id)}">Accept order</button>`;
        } else if (accepted && order.status !== "Cancelled") {
            action = `<button class="btn primary" data-action="share" data-order-id="${escapeHtml(order.id)}"${locationWatchId !== null ? " disabled" : ""}>${locationWatchId !== null ? "Sharing live location" : "Start sharing location"}</button>`;
            if (order.status !== "Delivered") {
                action += `<button class="btn" data-action="complete" data-order-id="${escapeHtml(order.id)}">Mark delivered</button>`;
            }
        }
        const assignmentState = isTerminal
            ? order.status
            : accepted
                ? (locationWatchId !== null ? "Accepted · sharing location" : "Accepted")
                : "New order · action required";
        return `<article class="driver-order-card">
            <div class="driver-order-heading"><div><strong>${escapeHtml(order.id)}</strong><span>${escapeHtml(assignmentState)}</span></div></div>
            <p><b>${escapeHtml(order.item)}</b> for ${escapeHtml(order.customer)}</p>
            <p>Delivery city: <b>${escapeHtml(order.city)}</b></p>
            <small>${lastLocation}</small>
            <div class="driver-order-actions">${action}</div>
        </article>`;
    }).join("");
}

function stopLocationSharing() {
    if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
}

async function sendDriverLocation(position) {
    if (locationSendInProgress || Date.now() - lastLocationSentAt < 4000) return;
    const activeOrders = acceptedActiveOrders();
    if (!activeOrders.length) {
        stopLocationSharing();
        renderOrders();
        return;
    }
    locationSendInProgress = true;
    try {
        const results = await Promise.all(activeOrders.map(order =>
            driverApi(`/api/driver/${encodeURIComponent(driverToken)}/orders/${encodeURIComponent(order.id)}/location`, {
                method: "POST",
                body: JSON.stringify({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude
                })
            })
        ));
        lastLocationSentAt = Date.now();
        const update = new Date().toLocaleTimeString();
        setMessage(`Live location shared for ${results.length} accepted order${results.length === 1 ? "" : "s"}. Last sent ${update}.`, "live");
        await loadAssignedOrders();
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        locationSendInProgress = false;
    }
}

function startLocationSharing() {
    if (!navigator.geolocation) {
        setMessage("This browser does not support GPS location sharing.", "error");
        return;
    }
    if (!window.isSecureContext) {
        setMessage("GPS requires HTTPS or localhost on this device.", "error");
        return;
    }
    if (locationWatchId !== null) return;
    if (!acceptedActiveOrders().length) {
        setMessage("Accept an active order before sharing your location.", "error");
        return;
    }
    setMessage("Waiting for location permission and GPS fix…");
    locationWatchId = navigator.geolocation.watchPosition(
        sendDriverLocation,
        error => {
            const explanation = error.code === error.PERMISSION_DENIED
                ? "Location permission was denied. Allow location access in browser settings and try again."
                : error.code === error.POSITION_UNAVAILABLE
                    ? "The device could not determine its location. Check GPS/location services."
                    : "GPS request timed out. Check location services and try again.";
            stopLocationSharing();
            setMessage(explanation, "error");
            renderOrders();
        },
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    );
    renderOrders();
}

async function loadAssignedOrders() {
    try {
        assignedOrders = await driverApi(`/api/driver/${encodeURIComponent(driverToken)}/orders`);
        const nextIds = new Set(assignedOrders.map(order => order.id));
        const newAssignments = knownOrderIds
            ? assignedOrders.filter(order => !knownOrderIds.has(order.id) && !order.driver_accepted_at)
            : [];
        knownOrderIds = nextIds;
        if (newAssignments.length) {
            setMessage(`New delivery order${newAssignments.length === 1 ? "" : "s"} received. Review and accept below.`, "new");
        } else if (!messageNode.classList.contains("live") && !messageNode.classList.contains("error")) {
            setMessage(assignedOrders.length ? "Orders are up to date." : "Waiting for a new delivery assignment.");
        }
        if (!acceptedActiveOrders().length) stopLocationSharing();
        renderOrders();
    } catch (error) {
        setMessage(error.message, "error");
    }
}

ordersNode.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const orderId = button.dataset.orderId;
    const action = button.dataset.action;
    button.disabled = true;
    try {
        if (action === "accept") {
            const result = await driverApi(
                `/api/driver/${encodeURIComponent(driverToken)}/orders/${encodeURIComponent(orderId)}/accept`,
                { method: "POST" }
            );
            setMessage(`${result.message} Your browser will ask for GPS permission.`, "new");
            await loadAssignedOrders();
            startLocationSharing();
        } else if (action === "share") {
            startLocationSharing();
        } else if (action === "complete") {
            const result = await driverApi(
                `/api/driver/${encodeURIComponent(driverToken)}/orders/${encodeURIComponent(orderId)}/complete`,
                { method: "POST" }
            );
            setMessage(result.message, "live");
            await loadAssignedOrders();
        }
    } catch (error) {
        setMessage(error.message, "error");
        button.disabled = false;
    }
});

loadAssignedOrders();
setInterval(loadAssignedOrders, 3000);
