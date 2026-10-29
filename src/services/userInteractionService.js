/**
 * Handles UI interactions with the terminal (f.e. when entering pin).
 */
class UserInteractionService {
    constructor() {
        if (!UserInteractionService.instance) {
            this.STATES = {
                READY: "READY",
                BUSY: "BUSY"
            };
            this.lastRequest = {};
            this.lastResponse = {};
            this.lastOutcome = null;
            this.state = this.STATES.READY;

            this.pin = "";
            this.isConfirmed = false;
        }

        return UserInteractionService.instance;
    }

    /**
     * Get the state of the terminal.
     * @returns {STATES} - String.
     */
    getState() {
        return this.state;
    }

    /**
     * Set the state of the terminal.
     * @param {STATES} state - State of the terminal.
     */
    setState(state) {
        if (this.state === state) {
            console.info("State remains unchanged.");
            return;
        }

        this.clearPin();
        this.setIsConfirmed(false);
        this.state = state;
        console.info("State changed to: " + state);
    }

    /**
     * Get the last response returned by the terminal.
     * @returns {JsonObject} - JsonObject.
     */
    getLastResponse() {
        return this.lastResponse;
    }

    /**
     * Set the last response returned by the terminal.
     * @param {JsonObject} lastResponse JsonObject
     */
    setLastResponse(lastResponse) {
        this.lastResponse = lastResponse;
        console.info("Last response is set to: " + JSON.stringify(this.lastResponse, null, 2));
    }

    /**
     * Get the last request returned by the terminal.
     * @returns {JsonObject} - JsonObject.
     */
    getLastRequest() {
        return this.lastRequest;
    }

    /**
     * Sets the last request returned by the terminal.
     * @param {JsonObject} lastRequest - JsonObject
     */
    setLastRequest(lastRequest) {
        this.lastRequest = lastRequest;
        console.info("Last request is set to: " + JSON.stringify(this.lastRequest, null, 2));
    }

    /**
     * How the last payment ended, for the terminal screen:
     * { result, errorCondition, amount, currency, brand, last4, at }.
     */
    getLastOutcome() {
        return this.lastOutcome;
    }

    /**
     * Records how a payment ended, from its PaymentResponse.
     * @param {JsonObject} response - The SaleToPOIResponse body.
     */
    setLastOutcome(response) {
        const payment = response?.SaleToPOIResponse?.PaymentResponse;
        if (!payment) {
            return;
        }
        const amounts = payment.PaymentResult?.AmountsResp;
        const card = payment.PaymentResult?.PaymentInstrumentData?.CardData;
        this.lastOutcome = {
            result: payment.Response?.Result,
            errorCondition: payment.Response?.ErrorCondition,
            amount: amounts?.AuthorizedAmount,
            currency: amounts?.Currency,
            brand: card?.PaymentBrand,
            last4: card?.MaskedPan ? card.MaskedPan.slice(-4) : undefined,
            at: new Date().toISOString(),
        };
    }

    /**
     * Remove last request returned by the terminal.
     */
    clearLastRequestAndResponse() {
        this.setLastRequest({});
        this.setLastResponse({});
    }

    /**
     * Gets the pin-code.
     * @returns {String} - Pin-code.
     */
    getPin() {
        return this.pin;
    }

    /**
     * Sets the pin-code.
     * @param {String} pin - Pin-code.
     */
    setPin(pin) {
        this.pin = pin;
    }

    /**
     * Removes the pin-code.
     */
    clearPin() {
        this.pin = "";
    }

    /**
     * Returns true when the green confirm-button is pressed on the terminal.
     * @returns {Boolean} - True when the confirm-button has been pressed.
     */
    getIsConfirmed() {
        return this.isConfirmed;
    }

    /**
     * Set to true when to green confirm-button is pressed on the terminal.
     * @param {Boolean} isConfirmed - Set to true when the confirm-button has been pressed.
     */
    setIsConfirmed(isConfirmed) {
        this.isConfirmed = isConfirmed;
    }
}

const userInteractionService = new UserInteractionService();
module.exports = {userInteractionService, STATES: userInteractionService.STATES};