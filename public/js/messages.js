/**
 The message list: every /sync exchange as one line that opens to its request and response,
 and the sample-request controls.
 **/

let messagesVersion = -1;
let newestSeenId = 0;
let autoOpenedId = null;   // The newest entry, opened automatically until the user toggles it.
const openIds = new Set();

function messagesElement(id) {
    return document.getElementById(id);
}

function formatTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatMessageAmount(amounts) {
    if (!amounts || typeof amounts.RequestedAmount !== "number") {
        return "";
    }
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: amounts.Currency }).format(amounts.RequestedAmount);
    } catch (error) {
        return `${amounts.RequestedAmount} ${amounts.Currency}`;
    }
}

/**
 * The one-line summary of an exchange: { category, detail, result, tone }.
 */
function summarize(entry) {
    const request = entry.request?.SaleToPOIRequest;
    if (!request) {
        return { category: "Invalid JSON", detail: "", result: "Event", tone: "declined" };
    }

    const header = request.MessageHeader || {};
    const category = header.MessageCategory || Object.keys(request).find((key) => key !== "MessageHeader") || "Request";
    let detail = header.ServiceID ? `#${header.ServiceID}` : "";
    if (request.PaymentRequest) {
        detail = `${formatMessageAmount(request.PaymentRequest.PaymentTransaction?.AmountsReq)} ${detail}`.trim();
    } else if (request.TransactionStatusRequest || request.AbortRequest) {
        const reference = (request.TransactionStatusRequest || request.AbortRequest).MessageReference;
        detail = reference?.ServiceID ? `for #${reference.ServiceID}` : "no reference";
    }

    if (!entry.done) {
        return { category, detail, result: "Waiting…", tone: "busy" };
    }
    if (entry.response === null) {
        return { category, detail, result: "200, no body", tone: "" };
    }
    const body = entry.response?.SaleToPOIResponse;
    const outcome = body && Object.values(body).find((value) => value && value.Response)?.Response;
    if (!outcome) {
        return { category, detail, result: "No response", tone: "declined" };
    }
    const result = outcome.Result === "Success" ? "Success" : `${outcome.Result} · ${outcome.ErrorCondition || ""}`.trim();
    return { category, detail, result, tone: outcome.Result === "Success" ? "approved" : "declined" };
}

function jsonBlock(title, value) {
    const section = document.createElement("section");
    section.className = "message-block";

    const heading = document.createElement("div");
    heading.className = "message-block-title";
    heading.textContent = title;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-button";
    copy.textContent = "Copy";

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-json";
    code.textContent = value === null ? "(no body)" : JSON.stringify(value, null, 2);
    pre.append(code);
    if (window.hljs && value !== null) {
        hljs.highlightElement(code);
    }

    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(value === null ? "" : JSON.stringify(value, null, 2));
            copy.textContent = "Copied";
            setTimeout(() => { copy.textContent = "Copy"; }, 1200);
        } catch (error) {
            console.error("Unable to copy to the clipboard: ", error);
        }
    });

    heading.append(copy);
    section.append(heading, pre);
    return section;
}

function renderEntry(entry) {
    const { category, detail, result, tone } = summarize(entry);

    const item = document.createElement("li");
    const details = document.createElement("details");
    details.className = "message";
    details.dataset.id = entry.id;
    if (openIds.has(entry.id)) {
        // Setting `open` fires a `toggle` event too; mark it so it is not taken for a click.
        details.dataset.programmatic = "true";
        details.open = true;
    }

    const summary = document.createElement("summary");
    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(entry.time);
    const what = document.createElement("span");
    what.className = "message-what";
    what.textContent = category;
    const extra = document.createElement("span");
    extra.className = "message-detail";
    extra.textContent = detail;
    const badge = document.createElement("span");
    badge.className = "message-result";
    badge.dataset.tone = tone;
    badge.textContent = result;
    summary.append(time, what, extra, badge);
    details.append(summary);

    // The JSON is only built for open entries.
    const fill = () => {
        if (details.open && details.childElementCount === 1) {
            details.append(jsonBlock("Request", entry.request), jsonBlock("Response", entry.done ? entry.response : { pending: true }));
        }
    };
    details.addEventListener("toggle", () => {
        if (details.dataset.programmatic) {
            delete details.dataset.programmatic;
            fill();
            return;
        }
        // The user opened or closed it: it is no longer the automatically opened one.
        if (details.open) {
            openIds.add(entry.id);
        } else {
            openIds.delete(entry.id);
        }
        if (entry.id === autoOpenedId) {
            autoOpenedId = null;
        }
        fill();
    });
    fill();

    item.append(details);
    return item;
}

function renderMessages(messages) {
    const newest = messages[0];
    if (newest && newest.id > newestSeenId) {
        // Open the newest exchange, and close the one opened automatically before it.
        if (autoOpenedId !== null) {
            openIds.delete(autoOpenedId);
        }
        openIds.add(newest.id);
        autoOpenedId = newest.id;
        newestSeenId = newest.id;
    }

    const list = messagesElement("message-list");
    list.replaceChildren(...messages.map(renderEntry));
    messagesElement("message-empty").hidden = messages.length > 0;
}

async function pollMessages() {
    try {
        const response = await sendGetRequest(`/user-interaction/messages?version=${messagesVersion}`);
        if (response.messages && response.version !== messagesVersion) {
            messagesVersion = response.version;
            renderMessages(response.messages);
        }
    } catch (error) {
        console.error(error);
    }
}

async function sendRequestButtonOnClick() {
    try {
        const prefix = messagesElement("request-dropdown").value;
        const requestToSend = await sendGetRequest("/requests/" + prefix);
        await sendPostRequest("/sync", requestToSend);
    } catch (error) {
        console.error(error);
    } finally {
        pollMessages();
    }
}

async function clearCodeblockButtonOnClick() {
    try {
        await sendPostRequest("/user-interaction/clear-codeblocks-button");
        openIds.clear();
        autoOpenedId = null;
    } catch (error) {
        console.error(error);
    } finally {
        pollMessages();
    }
}

// Collapses the pane to a strip, remembered per browser.
function bindMessagesToggle() {
    const toggle = messagesElement("messages-toggle");
    const app = document.querySelector(".app");
    const apply = (collapsed) => {
        app.classList.toggle("messages-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.textContent = collapsed ? "Messages" : "Hide";
    };
    let collapsed = false;
    try {
        collapsed = localStorage.getItem("messages-collapsed") === "true";
    } catch (error) {
        // Storage unavailable: start expanded.
    }
    apply(collapsed);
    toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        apply(collapsed);
        try {
            localStorage.setItem("messages-collapsed", String(collapsed));
        } catch (error) {
            // Not remembered.
        }
    });
}

messagesElement("send-button").addEventListener("click", sendRequestButtonOnClick);
messagesElement("clear-codeblock-button").addEventListener("click", clearCodeblockButtonOnClick);
bindMessagesToggle();
setInterval(pollMessages, 500);
pollMessages();
