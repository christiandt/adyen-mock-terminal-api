/**
 The terminal: its screen (amount, PIN, outcome) and keypad.
 **/

// How long an outcome ("Approved", "Declined", ...) stays on the screen.
const OUTCOME_SECONDS = 4;

const OUTCOME_TEXT = {
    Success: "Approved",
    Refusal: "Declined",
    InvalidCard: "Declined",
    WrongPIN: "Wrong PIN",
    Cancel: "Cancelled",
    Aborted: "Aborted",
};

let currentState = "READY";

function element(id) {
    return document.getElementById(id);
}

/**
 * An amount as the shopper sees it, e.g. "667,50 kr" or "€1.00", in the browser's locale.
 */
function formatAmount(amount, currency) {
    if (typeof amount !== "number" || !currency) {
        return "";
    }
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    } catch (error) {
        return `${amount} ${currency}`;
    }
}

// The idle screen's hint, the only markup put on the screen.
const IDLE_HINT = "Send Terminal API requests to <code>/sync</code>";

function setScreen({ amount = "", text = "", hint = "", idle = false, showPin = false, tone = "" }) {
    element("screen-amount").textContent = amount;
    element("screen").textContent = text;
    if (idle) {
        element("screen-hint").innerHTML = IDLE_HINT;
    } else {
        element("screen-hint").textContent = hint;
    }
    element("screen-pin").classList.toggle("hidden", !showPin);
    element("terminal-section").dataset.tone = tone;
}

function updatePin(pin) {
    element("screen-pin").textContent = pin;
}

function clearPin() {
    element("screen-pin").textContent = "";
}

/**
 * The text of a recent outcome, or null when there is none to show.
 */
function recentOutcome(lastOutcome) {
    if (!lastOutcome || Date.now() - Date.parse(lastOutcome.at) > OUTCOME_SECONDS * 1000) {
        return null;
    }
    const key = lastOutcome.result === "Success" ? "Success" : lastOutcome.errorCondition;
    return { text: OUTCOME_TEXT[key] || "Not approved", approved: lastOutcome.result === "Success", lastOutcome };
}

function updateState(response) {
    const wasBusy = currentState === "BUSY";
    currentState = response.state;

    if (response.state === "BUSY") {
        const payment = response.payment || {};
        if (!wasBusy) {
            clearPin();
        }
        setScreen({
            amount: formatAmount(payment.amount, payment.currency),
            text: "Enter your pin...",
            showPin: true,
            tone: "busy",
        });
        return;
    }

    clearPin();
    const outcome = recentOutcome(response.lastOutcome);
    if (outcome) {
        const card = outcome.lastOutcome.brand ? `${outcome.lastOutcome.brand} •••• ${outcome.lastOutcome.last4 || ""}` : "";
        setScreen({
            amount: formatAmount(outcome.lastOutcome.amount, outcome.lastOutcome.currency),
            text: outcome.text,
            hint: outcome.approved ? card : "",
            tone: outcome.approved ? "approved" : "declined",
        });
        return;
    }

    setScreen({ text: "Ready", idle: true });
}

function isAllowedToEnterPin() {
    return currentState === "BUSY";
}

function bindAllTerminalButtons() {
    // Binds 0...9 buttons.
    for (let i = 0; i < 10; i++) {
        element(i + "-button").addEventListener("click", async () => {
            if (!isAllowedToEnterPin()) {
                return;
            }
            try {
                const response = await sendPostRequest("/user-interaction/enter-pin");
                if (response && response.pin !== undefined) {
                    updatePin(response.pin);
                }
            } catch (error) {
                console.error(error);
            }
        });
    }

    // Binds green `confirm` button.
    element("confirm-button").addEventListener("click", async () => {
        if (!isAllowedToEnterPin()) {
            return;
        }
        if (element("screen-pin").textContent.length < 4) {
            element("screen").textContent = "PIN must be 4 digits";
            return;
        }
        await sendPostRequest("/user-interaction/confirm-button");
    });

    // Binds orange `clear` button.
    element("clear-button").addEventListener("click", async () => {
        if (!isAllowedToEnterPin()) {
            return;
        }
        await sendPostRequest("/user-interaction/clear-button");
        clearPin();
    });

    // Binds red `cancel` button.
    element("cancel-button").addEventListener("click", async () => {
        if (!isAllowedToEnterPin()) {
            return;
        }
        await sendPostRequest("/user-interaction/cancel-button");
    });
}

bindAllTerminalButtons();
pollEndpoint("/user-interaction/get-state", (response) => {
    updateState(response);
    document.dispatchEvent(new CustomEvent("terminal-state", { detail: response }));
});
