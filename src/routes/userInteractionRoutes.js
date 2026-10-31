const { userInteractionService, STATES } = require('../services/userInteractionService');
const terminalSettings = require('../services/terminalSettings');
const { listCards } = require('../services/cards');
const messageLog = require('../services/messageLog');
const { checkoutRefunds } = require('../services/checkoutRefunds');
const paymentService = require('../services/payloads/paymentService');
const express = require('express');
const router = express.Router();


/* Request & response code-blocks screen polling start */

// The terminal's state, the payment it is processing (for its screen) and how the last one ended.
router.get("/get-state", async (req, res) => {
    res.status(200).send({
        state: userInteractionService.getState(),
        payment: paymentService.inProgress(),
        lastOutcome: userInteractionService.getLastOutcome(),
    });
});

// The recent /sync exchanges, newest first. With ?version=<n> and nothing changed since,
// only { version } is returned.
router.get("/messages", async (req, res) => {
    if (req.query.version !== undefined && Number(req.query.version) === messageLog.version) {
        res.status(200).json({ version: messageLog.version });
        return;
    }
    res.status(200).json({ version: messageLog.version, messages: messageLog.list() });
});

router.get("/get-last-request", async (_req, res) => {
    res.status(200).json(userInteractionService.getLastRequest());
});

router.get("/get-last-response", async (req, res) => {
    res.status(200).json(userInteractionService.getLastResponse());
});

router.post("/clear-codeblocks-button", async (req, res) => {
    userInteractionService.clearLastRequestAndResponse();
    messageLog.clear();
    console.info("Cleared the request and response codeblocks.");
    res.status(200).send({});
});

/* Request & response code-blocks screen polling end */



/* Terminal settings start */

// The terminal's settings, e.g. { "autoConfirm": false, "autoConfirmDelayMs": 1000 }.
router.get("/settings", async (_req, res) => {
    res.status(200).json(terminalSettings.get());
});

// Changes any of the settings; answers with all of them, or 400 with an error.
router.post("/settings", async (req, res) => {
    const { settings, error } = terminalSettings.update(req.body);
    if (error) {
        res.status(400).json({ error });
        return;
    }
    res.status(200).json(settings);
});

// The cards the `card` setting can be: [{ "id": "visa", "label": "Visa (credit)" }, ...].
router.get("/cards", async (_req, res) => {
    res.status(200).json(listCards());
});

// How the Checkout API answers refunds and where their notifications go, e.g.
// { "outcome": "received", "notification": "success", "webhookUrl": null, "webhookDelayMs": 1000, "hmacKeySet": false }.
router.get("/refund-settings", async (_req, res) => {
    res.status(200).json(checkoutRefunds.getSettings());
});

// Changes any of the refund settings (also "hmacKey", which is never read back); answers with
// all of them, or 400 with an error.
router.post("/refund-settings", async (req, res) => {
    const { settings, error } = checkoutRefunds.updateSettings(req.body);
    if (error) {
        res.status(400).json({ error });
        return;
    }
    res.status(200).json(settings);
});

// The refunds made, newest first, each with the notifications sent for it and how they were answered.
router.get("/refunds", async (_req, res) => {
    res.status(200).json(checkoutRefunds.list());
});

// Forgets the refunds made (and their idempotency keys), and cancels notifications not yet sent.
router.delete("/refunds", async (_req, res) => {
    checkoutRefunds.clear();
    res.status(200).send({});
});

/* Terminal settings end */



/* Terminal-screen buttons start */

router.post("/enter-pin", async (req, res) => {
    let currentPin = userInteractionService.getPin();
    
    // Enforce a maximum length of 4 for pins.
    if (currentPin.length < 4) {
        userInteractionService.setPin(currentPin + "*");
    }

    res.status(200).send({ pin: userInteractionService.getPin() });
});

router.post("/confirm-button", async (req, res) => {
    if (userInteractionService.getPin().length === 4) {
        userInteractionService.setIsConfirmed(true);
        console.info("Set pin confirmed to true.");
    }
    res.status(200).send({});
});

router.post("/clear-button", async (req, res) => {
    if (userInteractionService.getState() !== STATES.BUSY) {
        res.status(200).send({});
        return;
    }
    
    userInteractionService.clearPin();
    res.status(200).send({});
});

router.post("/cancel-button", async (req, res) => {
    if (userInteractionService.getState() !== STATES.BUSY) {
        res.status(200).send({});
        return;
    }
    
    userInteractionService.clearLastRequestAndResponse();
    // Ends the payment at once, so a pending auto-confirm cannot approve it.
    if (!paymentService.cancel()) {
        userInteractionService.setState(STATES.READY);
    }

    console.info("Cancelled entering pin.");
    res.status(200).send({});
});


/* Terminal-screen buttons end */

module.exports = router;