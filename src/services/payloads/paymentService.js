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
            this.abortRequested = false;
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

        // Set terminal to busy and start handling logic.
        this.abortRequested = false;
        const tenderReference = newTenderReference();
        transactionStore.setInProgress({ saleId: header.SaleID, serviceId: header.ServiceID, tenderReference });
        userInteractionService.setState(STATES.BUSY);

        // Wait for the confirm button if a payment request is sent.
        const outcome = await this.getPinResultAsync();
        transactionStore.setInProgress(null);
        userInteractionService.setState(STATES.READY);

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
        const inProgress = transactionStore.getInProgress();
        if (!inProgress || userInteractionService.getState() !== STATES.BUSY) {
            return false;
        }
        if (messageReference?.ServiceID && messageReference.ServiceID !== inProgress.serviceId) {
            return false;
        }
        if (messageReference?.SaleID && messageReference.SaleID !== inProgress.saleId) {
            return false;
        }

        this.abortRequested = true;
        userInteractionService.setState(STATES.READY);
        return true;
    }

    /**
     * Blocking call that waits until the payment ends.
     * @returns {Promise<String>} - One of OUTCOMES.
     */
    getPinResultAsync = async () => {
        return new Promise(async resolve => {
            let totalSeconds = pinTimeoutSeconds();
            const waitForPinResult = () => {
                if (userInteractionService.getIsConfirmed() === true) {
                    // Pin code entered, accept any pin for now.
                    console.info("Confirm-button is pressed.");
                    resolve(OUTCOMES.CONFIRMED);
                } else if (userInteractionService.getState() === STATES.READY) {
                    // State changed: an AbortRequest, or the red `cancel-button` was pressed.
                    console.info(this.abortRequested ? "Payment aborted by the sale system." : "Cancelled entering-pin by user.");
                    resolve(this.abortRequested ? OUTCOMES.ABORTED : OUTCOMES.CANCELLED);
                } else if (totalSeconds > 0) {
                    // Waiting `totalSeconds` for user to enter pin...
                    console.info("Waiting for pin input... " + totalSeconds);
                    totalSeconds--;
                    setTimeout(waitForPinResult, 1000);
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
