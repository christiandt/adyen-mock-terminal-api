/**
 The device panel (bottom right, as in the virtual thermal printer): the terminal's state,
 its settings and where to connect a POS.
 **/

function panelElement(id) {
    return document.getElementById(id);
}

async function saveSettings(changes) {
    const response = await fetch("/user-interaction/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(body.error || "Could not save the setting.");
    }
    return body;
}

function showSettings(settings) {
    panelElement("auto-confirm-checkbox").checked = settings.autoConfirm === true;
    panelElement("auto-confirm-delay").value = settings.autoConfirmDelayMs;
    panelElement("auto-confirm-delay").disabled = settings.autoConfirm !== true;
    panelElement("card-select").value = settings.card;
    panelElement("card-last4").value = settings.cardLast4 || "";
}

async function bindSettings() {
    const select = panelElement("card-select");
    try {
        const [cards, settings] = await Promise.all([
            sendGetRequest("/user-interaction/cards"),
            sendGetRequest("/user-interaction/settings"),
        ]);
        for (const card of cards) {
            select.add(new Option(card.label, card.id));
        }
        showSettings(settings);
    } catch (error) {
        console.error(error);
    }

    // Saves a change; on an invalid value, shows the setting as it still is.
    const save = async (changes, input) => {
        input?.setCustomValidity("");
        try {
            showSettings(await saveSettings(changes));
        } catch (error) {
            if (input) {
                input.setCustomValidity(error.message);
                input.reportValidity();
            }
            showSettings(await sendGetRequest("/user-interaction/settings"));
        }
    };

    panelElement("auto-confirm-checkbox").addEventListener("change", (event) => save({ autoConfirm: event.target.checked }));
    panelElement("auto-confirm-delay").addEventListener("change", (event) => save({ autoConfirmDelayMs: Number(event.target.value) }, event.target));
    select.addEventListener("change", () => save({ card: select.value }));
    panelElement("card-last4").addEventListener("change", (event) => save({ cardLast4: event.target.value.trim() || null }, event.target));
}

function showRefundSettings(settings) {
    panelElement("refund-outcome").value = settings.outcome;
    panelElement("refund-notification").value = settings.notification;
    panelElement("refund-webhook-url").value = settings.webhookUrl || "";
}

// The refund settings: how the Checkout API answers a refund, and its notification. A change
// made before the settings have loaded is saved, and not undone when they arrive.
async function bindRefundSettings() {
    let changed = false;
    const save = async (changes, input) => {
        changed = true;
        input?.setCustomValidity("");
        const response = await fetch("/user-interaction/refund-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
        });
        const body = await response.json();
        if (!response.ok && input) {
            input.setCustomValidity(body.error || "Could not save the setting.");
            input.reportValidity();
        }
        showRefundSettings(response.ok ? body : await sendGetRequest("/user-interaction/refund-settings"));
    };

    panelElement("refund-outcome").addEventListener("change", (event) => save({ outcome: event.target.value }));
    panelElement("refund-notification").addEventListener("change", (event) => save({ notification: event.target.value }));
    panelElement("refund-webhook-url").addEventListener("change", (event) => save({ webhookUrl: event.target.value.trim() || null }, event.target));

    try {
        const settings = await sendGetRequest("/user-interaction/refund-settings");
        if (!changed) {
            showRefundSettings(settings);
        }
    } catch (error) {
        console.error(error);
    }
}

// The state light and label follow the terminal (see terminal.js).
function bindState() {
    document.addEventListener("terminal-state", (event) => {
        const busy = event.detail.state === "BUSY";
        panelElement("device-state").textContent = busy ? "waiting for PIN" : "ready";
        for (const id of ["device-state-light", "device-panel-light"]) {
            panelElement(id).dataset.state = busy ? "busy" : "ready";
        }
    });
}

// Hides the panel body, remembered per browser.
function bindPanelToggle() {
    const toggle = panelElement("device-panel-toggle");
    const panel = panelElement("device-panel");
    const apply = (collapsed) => {
        panel.classList.toggle("is-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        panelElement("device-panel-toggle-text").textContent = collapsed ? "Terminal" : "Hide";
    };
    let collapsed = false;
    try {
        collapsed = localStorage.getItem("device-panel-collapsed") === "true";
    } catch (error) {
        // Storage unavailable: start expanded.
    }
    apply(collapsed);
    toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        apply(collapsed);
        try {
            localStorage.setItem("device-panel-collapsed", String(collapsed));
        } catch (error) {
            // Not remembered.
        }
    });
}

panelElement("connect-url").textContent = `${location.origin}/sync`;
panelElement("checkout-url").textContent = `${location.origin}/checkout/v71`;
bindPanelToggle();
bindState();
bindSettings();
bindRefundSettings();
