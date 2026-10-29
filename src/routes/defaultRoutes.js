const payloadService = require('../services/payloadsService');
const { userInteractionService, STATES } = require('../services/userInteractionService');
const paymentService = require('../services/payloads/paymentService');
const { OUTCOMES } = require('../services/payloads/paymentService');
const transactionStore = require('../services/transactionStore');
const terminalSettings = require('../services/terminalSettings');
const messageLog = require('../services/messageLog');
const { buildTransactionStatusResponse } = require('../services/transactionStatusService');
const { buildResponse } = require('../services/responseBuilder');
const express = require('express');
const router = express.Router();

// Root index page.
router.get("/", async (req, res) => {
    const data = payloadService.getPayloads();
    res.render("index", {
        keys: Object.keys(data).filter(key => data[key][0] !== null) // Filter out empty requests, e.g. paymentBusy response
    });
});

// Used for request selection in the drop-down menu.
router.get("/requests/:prefix", async (req, res) => {
    const { prefix } = req.params;
    res.status(200).send(payloadService.getRequestByPrefix(prefix));
});

// The terminal accepts requests in this `/sync` endpoint.
router.post("/sync", async (req, res) => {
    console.info("Incoming /sync request ...");
    userInteractionService.setLastRequest(req.body);
    userInteractionService.setLastResponse({});
    const entry = messageLog.add(req.body);
    
    try {
        // Handle abort request: Adyen answers it with 200 OK and no body, and ends the payment it
        // names with ErrorCondition "Aborted".
        if (req.body.SaleToPOIRequest.AbortRequest) {
            paymentService.abort(req.body.SaleToPOIRequest.AbortRequest.MessageReference);
            messageLog.complete(entry, null);
            res.status(200).end();
            return;
        }

        // Handle transactionStatus request; answered while a payment is in progress too.
        if (req.body.SaleToPOIRequest.TransactionStatusRequest) {
            send(res, entry, buildTransactionStatusResponse(req.body));
            return;
        }

        // Handle paymentBusy response.
        if (userInteractionService.getState() === STATES.BUSY) {
            send(res, entry, buildResponse(payloadService.getResponseByPrefix("paymentBusy"), req.body));
            return;
        }

        // Handle payment request.
        if (paymentService.containsPrefix(req)) {
            const { outcome, prefix, tenderReference } = await paymentService.getResponse(req);
            const response = buildResponse(payloadService.getResponseByPrefix(prefix), req.body, {
                card: terminalSettings.card(),
                tenderReference,
                outcome: outcome === OUTCOMES.CONFIRMED ? undefined : outcome,
            });
            transactionStore.save("Payment", req.body, response);
            userInteractionService.setLastOutcome(response);
            send(res, entry, response);
            return;
        }

        // Handle reversal request.
        if (req.body.SaleToPOIRequest.ReversalRequest) {
            const response = buildResponse(payloadService.getResponseByPrefix("reversal"), req.body, {
                findPayment: (id) => transactionStore.findPayment(id),
            });
            transactionStore.save("Reversal", req.body, response);
            send(res, entry, response);
            return;
        }

        // Handle requests not found.
        userInteractionService.setState(STATES.READY);
        console.error("Request not found: " + req.body);
        messageLog.complete(entry, {});
        res.status(404).send({});
    } catch (e) {
        userInteractionService.setState(STATES.READY);
        console.error(e);
        messageLog.complete(entry, {});
        if (!res.headersSent) {
            res.status(500).send({});
        }
    }
});

/**
 * Sends `response` with 200 OK and shows it as the last response and in the message log.
 */
function send(res, entry, response) {
    userInteractionService.setLastResponse(response);
    messageLog.complete(entry, response);
    res.status(200).send(response);
}

module.exports = router;