const { checkoutRefunds } = require('../services/checkoutRefunds');
const express = require('express');
const router = express.Router();

// A referenced refund of a payment, by its PSP reference: the Checkout API's
// POST /payments/{paymentPspReference}/refunds, under any version (e.g. /checkout/v71/...).
// Point the POS's Checkout API base URL at http://<mock>/checkout/v71.
router.post("/:version(v\\d+)/payments/:paymentPspReference/refunds", async (req, res) => {
    const { status, body } = checkoutRefunds.refund({
        paymentPspReference: req.params.paymentPspReference,
        apiKey: req.get("X-API-Key"),
        idempotencyKey: req.get("Idempotency-Key"),
        body: req.body,
    });
    res.status(status).json(body);
});

module.exports = router;
