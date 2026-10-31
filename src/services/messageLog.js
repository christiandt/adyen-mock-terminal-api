/**
 * The recent request/response exchanges, for the page's message list.
 *
 * Each entry is { id, time, kind, summary, request, response, done }. A request's entry is added when
 * it arrives (a payment waiting for its PIN shows as pending) and completed when it is answered;
 * an AbortRequest is answered with no body (response null). `kind` is "terminal" for /sync,
 * "refund" for a Checkout API refund and "notification" for a webhook notification the mock
 * sent (its "response" is how the webhook answered). `summary` holds what the page shows of
 * it that it cannot work out itself, e.g. a refund's amount in major units. `version` changes with every
 * addition, completion or clear, so the page can skip a redraw when nothing changed.
 */

const MAX_MESSAGES = 100;

class MessageLog {
    constructor() {
        this.entries = [];
        this.nextId = 1;
        this.version = 0;
    }

    /**
     * Adds a request; returns its entry, to complete when it is answered.
     */
    add(request, kind = "terminal", summary = null) {
        const entry = { id: this.nextId++, time: new Date().toISOString(), kind, summary, request, response: null, done: false };
        this.entries.push(entry);
        if (this.entries.length > MAX_MESSAGES) {
            this.entries.shift();
        }
        this.version++;
        return entry;
    }

    /**
     * Records the response to an entry (null for a response without a body).
     */
    complete(entry, response) {
        if (!entry || entry.done) {
            return;
        }
        entry.response = response;
        entry.done = true;
        this.version++;
    }

    /**
     * The entries, newest first.
     */
    list() {
        return this.entries.slice().reverse();
    }

    clear() {
        this.entries = [];
        this.version++;
    }
}

const messageLog = new MessageLog();
module.exports = messageLog;
