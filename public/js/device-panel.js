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
bindPanelToggle();
bindState();
bindSettings();
