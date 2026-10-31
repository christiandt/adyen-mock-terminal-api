/**
 * Referenced refunds on Adyen's Checkout API, for a POS that refunds a terminal payment to
 * its card without the card: POST /checkout/v71/payments/{paymentPspReference}/refunds
 * (https://docs.adyen.com/api-explorer/Checkout/71/post/payments/(paymentPspReference)/refunds).
 *
 * As at Adyen, the request is only accepted (201, status "received"); whether the money
 * reached the card comes later in a REFUND webhook notification
 * (https://docs.adyen.com/online-payments/refund/#refund-webhook), which the mock posts to
 * `webhookUrl`, HMAC-signed with `hmacKey`
 * (https://docs.adyen.com/development-resources/webhooks/verify-hmac-signatures/).
 *
 * Settings, at start-up (environment variables) or at runtime (/user-interaction/refund-settings):
 * - outcome: how the request is answered (REFUND_OUTCOME, default "received"):
 *   - "received": 201, and the notification follows;
 *   - "refused": 422, nothing is refunded;
 *   - "serverError": 500, nothing is refunded;
 *   - "lostAnswer": the refund is made (and notified) but answered with 500, as when the
 *     answer is lost on the way; a retry with the same Idempotency-Key gets the 201.
 * - notification: what the REFUND notification says (REFUND_NOTIFICATION, default "success"):
 *   "success", "failed" (success "false"), "refundFailed" (REFUND, then REFUND_FAILED, as when
 *   the card scheme rejects it later) or "none".
 * - webhookUrl: where notifications are posted, without credentials in it, or null for none
 *   (WEBHOOK_URL).
 * - hmacKey: the hex HMAC key notifications are signed with, or null (HMAC_KEY). Never read back.
 *   A refund's notifications use the webhookUrl and hmacKey set when the refund was made.
 * - webhookDelayMs: how long after the refund the notification is sent, 0-60000 ms
 *   (WEBHOOK_DELAY_MS, default 1000).
 */
const crypto = require("crypto");
const messageLog = require("./messageLog");
const { newPspReference, fromMinorUnits } = require("./responseBuilder");

const OUTCOMES = ["received", "refused", "serverError", "lostAnswer"];
const NOTIFICATIONS = ["success", "failed", "refundFailed", "none"];
const MAX_DELAY_MS = 60000;
const MAX_REFUNDS = 1000;
const MAX_IDEMPOTENCY_KEYS = 100000;

function envChoice(value, choices, fallback) {
    return choices.includes(value) ? value : fallback;
}

function envDelay(value, fallback) {
    const ms = parseInt(value, 10);
    return Number.isInteger(ms) && ms >= 0 && ms <= MAX_DELAY_MS ? ms : fallback;
}

function isHmacKey(value) {
    return typeof value === "string" && value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function isWebhookUrl(value) {
    try {
        const url = new URL(value);
        // fetch refuses a URL with credentials in it, so such a webhook could never be reached.
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
    } catch (error) {
        return false;
    }
}

/**
 * The colon-escaped value for the HMAC signing string: "\" and ":" are escaped with "\".
 */
function escape(value) {
    return String(value ?? "").replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * The HMAC signature of a NotificationRequestItem, as Adyen computes it: HMAC-SHA256 with the
 * hex-decoded key over pspReference:originalReference:merchantAccountCode:merchantReference:
 * value:currency:eventCode:success, Base64-encoded.
 */
function hmacSignature(item, hmacKey) {
    const signingString = [
        item.pspReference, item.originalReference, item.merchantAccountCode, item.merchantReference,
        item.amount?.value, item.amount?.currency, item.eventCode, item.success,
    ].map(escape).join(":");
    return crypto.createHmac("sha256", Buffer.from(hmacKey, "hex")).update(signingString, "utf8").digest("base64");
}

class CheckoutRefunds {
    constructor() {
        this.settings = {
            outcome: envChoice(process.env.REFUND_OUTCOME, OUTCOMES, "received"),
            notification: envChoice(process.env.REFUND_NOTIFICATION, NOTIFICATIONS, "success"),
            webhookUrl: isWebhookUrl(process.env.WEBHOOK_URL) ? process.env.WEBHOOK_URL : null,
            webhookDelayMs: envDelay(process.env.WEBHOOK_DELAY_MS, 1000),
        };
        this.hmacKey = isHmacKey(process.env.HMAC_KEY) ? process.env.HMAC_KEY : null;
        // Idempotency-Key -> { status, body } of the refund it made. Kept apart from the history
        // below, and far longer, so a late retry never refunds again.
        this.byIdempotencyKey = new Map();
        // The refunds made, oldest first, each with the notifications sent for it.
        this.refunds = [];
        this.timers = new Set();
        // Bumped by clear(): a notification sequence still running stops before its next event.
        this.generation = 0;
    }

    /**
     * The settings, with whether an HMAC key is set but never the key.
     */
    getSettings() {
        return { ...this.settings, hmacKeySet: this.hmacKey !== null };
    }

    /**
     * Changes the given settings.
     * @param {Object} changes - Any of { outcome, notification, webhookUrl, hmacKey, webhookDelayMs }.
     * @returns {{settings?: Object, error?: String}}
     */
    updateSettings(changes) {
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
            return { error: "Send a JSON object." };
        }
        const next = { ...this.settings };
        let hmacKey = this.hmacKey;
        for (const [key, value] of Object.entries(changes)) {
            if (key === "outcome") {
                if (!OUTCOMES.includes(value)) {
                    return { error: `outcome must be one of: ${OUTCOMES.join(", ")}.` };
                }
                next.outcome = value;
            } else if (key === "notification") {
                if (!NOTIFICATIONS.includes(value)) {
                    return { error: `notification must be one of: ${NOTIFICATIONS.join(", ")}.` };
                }
                next.notification = value;
            } else if (key === "webhookUrl") {
                if (value !== null && !isWebhookUrl(value)) {
                    return { error: "webhookUrl must be an http(s) URL without credentials, or null." };
                }
                next.webhookUrl = value;
            } else if (key === "hmacKey") {
                if (value !== null && !isHmacKey(value)) {
                    return { error: "hmacKey must be a hex string, or null." };
                }
                hmacKey = value;
            } else if (key === "webhookDelayMs") {
                if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
                    return { error: `webhookDelayMs must be a whole number from 0 to ${MAX_DELAY_MS}.` };
                }
                next.webhookDelayMs = value;
            } else {
                return { error: `Unknown setting: ${key}.` };
            }
        }
        this.settings = next;
        this.hmacKey = hmacKey;
        console.info("Refund settings: " + JSON.stringify(this.getSettings()));
        return { settings: this.getSettings() };
    }

    /**
     * Answers a refund request.
     * @param {Object} request - { paymentPspReference, apiKey, idempotencyKey, body }.
     * @returns {{status: Number, body: Object}}
     */
    refund({ paymentPspReference, apiKey, idempotencyKey, body }) {
        const entry = messageLog.add({ refund: { paymentPspReference, idempotencyKey: idempotencyKey || null, body } }, "refund", {
            amount: validate(body) ? null : majorAmount(body.amount),
        });
        const answer = this.answer({ paymentPspReference, apiKey, idempotencyKey, body });
        messageLog.complete(entry, { status: answer.status, body: answer.body });
        return answer;
    }

    answer({ paymentPspReference, apiKey, idempotencyKey, body }) {
        if (!apiKey) {
            return error(401, "000", "HTTP Status Response - Unauthorized", "security");
        }
        // The same Idempotency-Key gets the answer of the refund it made, and refunds nothing more.
        if (idempotencyKey && this.byIdempotencyKey.has(idempotencyKey)) {
            return this.byIdempotencyKey.get(idempotencyKey);
        }

        const invalid = validate(body);
        if (invalid) {
            return error(422, "mock_validation", invalid, "validation");
        }
        const { outcome } = this.settings;
        if (outcome === "refused") {
            return error(422, "mock_refused", "Refund refused by the mock's refund setting", "validation");
        }
        if (outcome === "serverError") {
            return error(500, "mock_server_error", "Internal error (the mock's refund setting); nothing was refunded", "internal");
        }

        const refund = {
            merchantAccount: body.merchantAccount,
            paymentPspReference,
            pspReference: newPspReference(),
            ...(body.reference !== undefined ? { reference: body.reference } : {}),
            status: "received",
            amount: { currency: body.amount.currency, value: body.amount.value },
        };
        const made = { status: 201, body: refund };
        if (idempotencyKey) {
            this.byIdempotencyKey.set(idempotencyKey, made);
            if (this.byIdempotencyKey.size > MAX_IDEMPOTENCY_KEYS) {
                this.byIdempotencyKey.delete(this.byIdempotencyKey.keys().next().value);
            }
        }
        this.record(refund);

        if (outcome === "lostAnswer") {
            return error(500, "mock_lost_answer", "Internal error (the mock's refund setting); the refund was made", "internal");
        }
        return made;
    }

    /**
     * Keeps a refund made and schedules its notification.
     */
    record(refund) {
        const record = { time: new Date().toISOString(), refund, notifications: [] };
        this.refunds.push(record);
        if (this.refunds.length > MAX_REFUNDS) {
            this.refunds.shift();
        }

        // The destination and key as they are now: a later change does not reach this refund's
        // notifications, so they all go where they were meant to, signed for that receiver.
        const { notification, webhookUrl, webhookDelayMs } = this.settings;
        const hmacKey = this.hmacKey;
        if (notification === "none" || !webhookUrl) {
            return;
        }
        const events = notification === "refundFailed"
            ? [["REFUND", "true", ""], ["REFUND_FAILED", "true", "Refund rejected by the card scheme (mock)"]]
            : [["REFUND", notification === "success" ? "true" : "false", notification === "success" ? "" : "Refund failed (mock)"]];
        const generation = this.generation;
        const timer = setTimeout(async () => {
            this.timers.delete(timer);
            for (const [eventCode, success, reason] of events) {
                if (generation !== this.generation) {
                    return;
                }
                await this.notify(record, { webhookUrl, hmacKey }, { eventCode, success, reason });
            }
        }, webhookDelayMs);
        this.timers.add(timer);
    }

    /**
     * Posts one notification about a refund and records how the webhook answered.
     */
    async notify(record, { webhookUrl, hmacKey }, { eventCode, success, reason }) {
        const { refund } = record;
        const item = {
            additionalData: {},
            amount: refund.amount,
            eventCode,
            eventDate: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
            merchantAccountCode: refund.merchantAccount,
            merchantReference: refund.reference ?? "",
            originalReference: refund.paymentPspReference,
            paymentMethod: "visa",
            pspReference: refund.pspReference,
            reason,
            success,
        };
        if (hmacKey) {
            item.additionalData.hmacSignature = hmacSignature(item, hmacKey);
        }
        const payload = { live: "false", notificationItems: [{ NotificationRequestItem: item }] };
        const sent = { eventCode, success, webhookUrl, status: null, body: null, error: null };
        record.notifications.push(sent);
        const entry = messageLog.add({ notification: payload, webhookUrl }, "notification", {
            amount: majorAmount(refund.amount),
        });
        try {
            const response = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });
            sent.status = response.status;
            sent.body = await response.text();
        } catch (err) {
            sent.error = err.message;
        }
        messageLog.complete(entry, { status: sent.status, body: sent.body, error: sent.error });
        console.info(`Refund ${refund.pspReference}: ${eventCode} notification -> ${sent.status ?? sent.error}`);
    }

    /**
     * The refunds made, newest first, each with its notifications.
     */
    list() {
        return this.refunds.slice().reverse();
    }

    clear() {
        this.generation++;
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.refunds = [];
        this.byIdempotencyKey.clear();
    }
}

/**
 * An amount in minor units as { value, currency } in major units, by Adyen's currency table,
 * for the page to show (e.g. 100 ISK minor units -> 1 ISK).
 */
function majorAmount(amount) {
    return { value: fromMinorUnits(amount.value, amount.currency), currency: amount.currency };
}

function error(status, errorCode, message, errorType) {
    return { status, body: { status, errorCode, message, errorType } };
}

/**
 * Why a refund request body is invalid, or null.
 */
function validate(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "Send a JSON object";
    }
    if (typeof body.merchantAccount !== "string" || !body.merchantAccount) {
        return "Required field 'merchantAccount' is not provided.";
    }
    const amount = body.amount;
    if (!amount || typeof amount !== "object") {
        return "Required field 'amount' is not provided.";
    }
    if (typeof amount.currency !== "string" || !/^[A-Z]{3}$/.test(amount.currency)) {
        return "Field 'amount.currency' must be a three-letter ISO 4217 code.";
    }
    if (!Number.isInteger(amount.value) || amount.value <= 0) {
        return "Field 'amount.value' must be a whole number of minor units above 0.";
    }
    return null;
}

const checkoutRefunds = new CheckoutRefunds();
module.exports = { checkoutRefunds, hmacSignature, OUTCOMES, NOTIFICATIONS };
