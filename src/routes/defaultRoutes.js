const payloadService = require('../services/payloadsService');
const { userInteractionService, STATES } = require('../services/userInteractionService');
const paymentService = require('../services/payloads/paymentService');
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
    
    try {
        // Handle abort request.
        if (req.body.SaleToPOIRequest.AbortRequest) {
            userInteractionService.setState(STATES.READY);
            sendOKResponse(req, res, "abortPayment");
            return;
        }

        // Handle paymentBusy response.
        if (userInteractionService.getState() === STATES.BUSY) {
            sendOKResponse(req, res, "paymentBusy");
            return;
        }

        // Handle payment request.
        if (paymentService.containsPrefix(req)) {
            const paymentResponse = await paymentService.getResponse(req);
            sendOKResponse(req, res, paymentResponse);
            return;
        }

        // Handle reversal request.
        if (req.body.SaleToPOIRequest.ReversalRequest) {
            sendOKResponse(req, res, "reversal");
            return;
        }

        // Handle paymentTransactionStatus request.
        if (req.body.SaleToPOIRequest.TransactionStatusRequest) {
            sendOKResponse(req, res, "paymentTransactionStatus");
            return;
        }

        // Handle requests not found.
        userInteractionService.setState(STATES.READY);
        console.error("Request not found: " + req.body);
        res.status(404).send({});
    } catch (e) {
        userInteractionService.setState(STATES.READY);
        console.error(e);
    }
});

/**
 * Helper function that returns a 200 response for given `prefix` key, built for the request `req`.
 * If {} is provided as prefix, we skip the look-up and return {}.
 */
function sendOKResponse(req, res, prefix) {
    if (prefix === {}) {
        res.status(200).send({})
        return;
    }
    
    const response = buildResponse(payloadService.getResponseByPrefix(prefix), req.body);
    userInteractionService.setLastResponse(response);
    res.status(200).send(response);
}

module.exports = router;