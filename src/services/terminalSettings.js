/**
 * Settings of the mock terminal that change how it behaves, at start-up (environment variables)
 * or at runtime (`/user-interaction/settings`).
 *
 * - autoConfirm: a payment is confirmed as if a PIN were entered, after autoConfirmDelayMs,
 *   so automated tests need not drive the terminal screen. (AUTO_CONFIRM=true)
 * - autoConfirmDelayMs: how long the terminal "waits for the shopper" first, 0-60000 ms
 *   (AUTO_CONFIRM_DELAY_MS, default 1000). An AbortRequest or TransactionStatusRequest can be
 *   sent meanwhile.
 * - card: the card an approved payment is made with, one of src/services/cards.js
 *   (CARD, default "visa").
 * - cardLast4: four digits to use instead of the card's own, or null (CARD_LAST4).
 */
const { CARDS, DEFAULT_CARD_ID, resolveCard } = require("./cards");

const MAX_DELAY_MS = 60000;

function envFlag(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function envDelay(value, fallback) {
    const ms = parseInt(value, 10);
    return Number.isInteger(ms) && ms >= 0 && ms <= MAX_DELAY_MS ? ms : fallback;
}

class TerminalSettings {
    constructor() {
        this.settings = {
            autoConfirm: envFlag(process.env.AUTO_CONFIRM),
            autoConfirmDelayMs: envDelay(process.env.AUTO_CONFIRM_DELAY_MS, 1000),
            card: CARDS[process.env.CARD] ? process.env.CARD : DEFAULT_CARD_ID,
            cardLast4: /^\d{4}$/.test(process.env.CARD_LAST4 || "") ? process.env.CARD_LAST4 : null,
        };
    }

    get() {
        return { ...this.settings };
    }

    /**
     * The card an approved payment is made with.
     */
    card() {
        return resolveCard(this.settings.card, this.settings.cardLast4);
    }

    /**
     * Changes the given settings.
     * @param {Object} changes - Any of { autoConfirm: Boolean, autoConfirmDelayMs: Number, card: String, cardLast4: String|null }.
     * @returns {{settings?: Object, error?: String}}
     */
    update(changes) {
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
            return { error: "Send a JSON object." };
        }

        const next = { ...this.settings };
        for (const [key, value] of Object.entries(changes)) {
            if (key === "autoConfirm") {
                if (typeof value !== "boolean") {
                    return { error: "autoConfirm must be true or false." };
                }
                next.autoConfirm = value;
            } else if (key === "autoConfirmDelayMs") {
                if (!Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
                    return { error: `autoConfirmDelayMs must be a whole number from 0 to ${MAX_DELAY_MS}.` };
                }
                next.autoConfirmDelayMs = value;
            } else if (key === "card") {
                if (!CARDS[value]) {
                    return { error: `card must be one of: ${Object.keys(CARDS).join(", ")}.` };
                }
                next.card = value;
            } else if (key === "cardLast4") {
                if (value !== null && !(typeof value === "string" && /^\d{4}$/.test(value))) {
                    return { error: "cardLast4 must be four digits, as a string, or null." };
                }
                next.cardLast4 = value;
            } else {
                return { error: `Unknown setting: ${key}.` };
            }
        }

        this.settings = next;
        console.info("Terminal settings: " + JSON.stringify(this.settings));
        return { settings: this.get() };
    }
}

const terminalSettings = new TerminalSettings();
module.exports = terminalSettings;
