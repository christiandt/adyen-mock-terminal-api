const { userInteractionService, STATES } = require("../userInteractionService");
const transactionStore = require("../transactionStore");
const { newTenderReference } = require("../responseBuilder");

const paymentFailureMap = {
    "124": "124_paymentNotEnoughBalance",
    "125": "125_paymentCardBlocked",
    "126": "126_paymentCardExpired",
    "127": "127_paymentInvalidAmount",
    "128": "128_paymentInvalidCard",
    "134": "134_paymentWrongPin"
};

/**
 * How a payment waiting for the shopper ended.
 */
const OUTCOMES = {
    CONFIRMED: "CONFIRMED", // The PIN was entered and confirmed.
    ABORTED: "ABORTED",     // The till sent an AbortRequest for it.
    CANCELLED: "CANCELLED", // The red cancel button was pressed on the terminal.
    TIMED_OUT: "TIMED_OUT", // Nobody entered a PIN in time.
};

/**
 * Seconds a payment waits for the PIN before it times out (PIN_TIMEOUT_SECONDS, default 180).
 */
function pinTimeoutSeconds() {
    const seconds = parseInt(process.env.PIN_TIMEOUT_SECONDS, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 180;
}

/**
 * Helper class that determines which `paymentResponse` to return.
 */
class PaymentService {
    constructor() {
        if (!PaymentService.instance) {
            // The payment the terminal is processing: { outcome } once it has ended.
            this.current = null;
        }

        return PaymentService.instance;
    }

    containsPrefix(request) {
        return request.body.SaleToPOIRequest.PaymentRequest;
    }

    /**
     * Waits for the shopper and returns how the payment ended, with the payload to answer it.
     * @returns {Promise<{outcome: String, prefix: String, tenderReference: String}>}
     */
    async getResponse(request) {
        const header = request.body.SaleToPOIRequest.MessageHeader || {};

        // Set terminal to busy and start handling logic. Each payment has its own record of how
        // it ended, so a payment started right after an abort cannot take over the aborted one's.
        const payment = { saleId: header.SaleID, serviceId: header.ServiceID, outcome: null };
        const tenderReference = newTenderReference();
        this.current = payment;
        transactionStore.setInProgress({ saleId: header.SaleID, serviceId: header.ServiceID, tenderReference });
        userInteractionService.setState(STATES.BUSY);

        // Wait for the confirm button if a payment request is sent.
        const outcome = await this.getPinResultAsync(payment);
        this.finish(payment);

        if (outcome !== OUTCOMES.CONFIRMED) {
            return { outcome, prefix: "abortPayment", tenderReference };
        }

        const amount = request.body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq.RequestedAmount;
        const lastThreeDigits = amount.toString()
            .replace('.', '')
            .padStart(3, '0')
            .slice(-3);

        // Look up error code from payment failure.
        const paymentFailure = paymentFailureMap[lastThreeDigits];

        return { outcome, prefix: paymentFailure || "payment", tenderReference };
    }

    /**
     * Ends the payment in progress as aborted, if it is the one `messageReference` names.
     * @param {Object} messageReference - The AbortRequest's MessageReference.
     * @returns {Boolean} - Whether a payment was aborted.
     */
    abort(messageReference) {
        const payment = this.current;
        if (!payment) {
            return false;
        }
        if (messageReference?.ServiceID && messageReference.ServiceID !== payment.serviceId) {
            return false;
        }
        if (messageReference?.SaleID && messageReference.SaleID !== payment.saleId) {
            return false;
        }

        // The payment ends now, before the abort is answered: the terminal is free for the next
        // payment, and the waiting request resolves at once, so its response is built and stored
        // (for a TransactionStatusRequest) before the server handles another request.
        payment.outcome = OUTCOMES.ABORTED;
        this.finish(payment);
        payment.end?.(OUTCOMES.ABORTED);
        return true;
    }

    /**
     * Frees the terminal after `payment`, unless another payment has taken it since.
     */
    finish(payment) {
        if (this.current !== payment) {
            return;
        }
        this.current = null;
        transactionStore.setInProgress(null);
        userInteractionService.setState(STATES.READY);
    }

    /**
     * Blocking call that waits until `payment` ends.
     * @param {Object} payment - The payment's own record; its `outcome` is set when it is aborted.
     * @returns {Promise<String>} - One of OUTCOMES.
     */
    getPinResultAsync = async (payment) => {
        return new Promise(async settle => {
            let totalSeconds = pinTimeoutSeconds();
            let timer = null;
            let ended = false;
            const resolve = (outcome) => {
                if (ended) {
                    return;
                }
                ended = true;
                clearTimeout(timer);
                settle(outcome);
            };
            // Lets abort() end the payment without waiting for the next poll.
            payment.end = resolve;

            const waitForPinResult = () => {
                if (payment.outcome) {
                    // Ended by an AbortRequest. The terminal's state may already belong to the next payment.
                    console.info("Payment aborted by the sale system.");
                    resolve(payment.outcome);
                } else if (userInteractionService.getIsConfirmed() === true) {
                    // Pin code entered, accept any pin for now.
                    console.info("Confirm-button is pressed.");
                    resolve(OUTCOMES.CONFIRMED);
                } else if (userInteractionService.getState() === STATES.READY) {
                    // State changed: the red `cancel-button` was pressed.
                    console.info("Cancelled entering-pin by user.");
                    resolve(OUTCOMES.CANCELLED);
                } else if (totalSeconds > 0) {
                    // Waiting `totalSeconds` for user to enter pin...
                    console.info("Waiting for pin input... " + totalSeconds);
                    totalSeconds--;
                    timer = setTimeout(waitForPinResult, 1000);
                } else {
                    // Time out.
                    console.info("Request has timed-out.");
                    resolve(OUTCOMES.TIMED_OUT);
                }
            };

            waitForPinResult();
        });
    };
}

const paymentService = new PaymentService();
module.exports = paymentService;
module.exports.OUTCOMES = OUTCOMES;
