/**
 * Remembers the transactions the terminal has handled, so a TransactionStatusRequest can
 * return the result of the one it names, and a reversal can find the payment it reverses.
 *
 * A TransactionStatusRequest names a transaction by the SaleID and ServiceID of its request
 * (MessageReference). Adyen requires a ServiceID to be unique per terminal for 48 hours;
 * the mock keeps the most recent transactions, which is enough for testing.
 */

const MAX_TRANSACTIONS = 1000;

class TransactionStore {
    constructor() {
        // "<SaleID>|<ServiceID>" -> { category, request, response }
        this.byReference = new Map();
        // POITransactionID.TransactionID -> the PaymentResponse's SaleToPOIResponse
        this.byPoiTransactionId = new Map();
        // The payment the terminal is processing: { saleId, serviceId, tenderReference }
        this.inProgress = null;
    }

    key(saleId, serviceId) {
        return `${saleId}|${serviceId}`;
    }

    /**
     * Records the response to a request.
     * @param {String} category - "Payment" or "Reversal".
     * @param {Object} request - The request body.
     * @param {Object} response - The response body.
     */
    save(category, request, response) {
        const header = request?.SaleToPOIRequest?.MessageHeader;
        if (!header?.SaleID || !header?.ServiceID) {
            return;
        }

        this.byReference.delete(this.key(header.SaleID, header.ServiceID));
        this.byReference.set(this.key(header.SaleID, header.ServiceID), { category, request, response });

        const transactionId = response?.SaleToPOIResponse?.PaymentResponse?.POIData?.POITransactionID?.TransactionID;
        if (category === "Payment" && transactionId) {
            this.byPoiTransactionId.set(transactionId, response.SaleToPOIResponse);
        }

        // Forget the oldest transactions beyond the limit.
        while (this.byReference.size > MAX_TRANSACTIONS) {
            const [oldest, entry] = this.byReference.entries().next().value;
            this.byReference.delete(oldest);
            const oldId = entry.response?.SaleToPOIResponse?.PaymentResponse?.POIData?.POITransactionID?.TransactionID;
            if (oldId) {
                this.byPoiTransactionId.delete(oldId);
            }
        }
    }

    /**
     * The recorded transaction for a MessageReference, if any.
     * @returns {{category: String, request: Object, response: Object}|undefined}
     */
    find(saleId, serviceId) {
        return this.byReference.get(this.key(saleId, serviceId));
    }

    /**
     * The payment with this POITransactionID (as a SaleToPOIResponse), if any.
     */
    findPayment(poiTransactionId) {
        return this.byPoiTransactionId.get(poiTransactionId);
    }

    setInProgress(reference) {
        this.inProgress = reference;
    }

    getInProgress() {
        return this.inProgress;
    }

    clear() {
        this.byReference.clear();
        this.byPoiTransactionId.clear();
        this.inProgress = null;
    }
}

const transactionStore = new TransactionStore();
module.exports = transactionStore;
