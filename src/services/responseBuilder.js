/**
 * Builds the response to a request from its canned payload.
 *
 * The payloads in `/public/payloads` are recorded responses, so on their own every
 * response carries the same IDs and amount (1.00 EUR). A terminal answers the request
 * it was sent: the same ServiceID, SaleID and POIID in the header, the requested amount
 * and currency, the sale's own transaction ID, and a new transaction (PSP) reference.
 * This fills those in, so an integration can match a response to its request.
 */

// The card a successful payment is made with: Adyen's Visa test card.
const DEFAULT_CARD = {
    brand: "visa",
    bin: "411111",
    last4: "1111",
    expiryMonth: "03",
    expiryYear: "2030",
    countryCode: "578",
    issuerCountry: "NO",
    fundingSource: "CREDIT",
    entryMode: "ICC",
};

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * A new PSP reference: 16 upper-case letters and digits, as Adyen issues them.
 * @returns {String}
 */
function newPspReference() {
    let reference = "";
    for (let i = 0; i < 16; i++) {
        reference += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
    }
    return reference;
}

/**
 * The terminal's transaction ID: "<tender reference>.<PSP reference>".
 * @param {String} pspReference
 * @returns {String}
 */
function poiTransactionId(pspReference) {
    return `MOCK${Date.now()}.${pspReference}`;
}

/**
 * An amount in minor units, e.g. 667.5 -> 66750.
 * @param {Number} amount
 * @returns {Number}
 */
function minorUnits(amount) {
    return Math.round(Number(amount) * 100);
}

/**
 * Copies the identifiers the terminal echoes from the request header.
 */
function echoHeader(response, request) {
    const requestHeader = request?.SaleToPOIRequest?.MessageHeader;
    const responseHeader = response?.SaleToPOIResponse?.MessageHeader;
    if (!requestHeader || !responseHeader) {
        return;
    }

    for (const key of ["ServiceID", "SaleID", "POIID"]) {
        if (requestHeader[key] !== undefined) {
            responseHeader[key] = requestHeader[key];
        }
    }
}

/**
 * The AdditionalResponse of an approved payment, URL-encoded as the terminal sends it.
 */
function approvedAdditionalResponse({ pspReference, amountsReq, saleTransactionId, poiid, card, now }) {
    const value = String(minorUnits(amountsReq.RequestedAmount));
    const fields = {
        tid: poiid ? poiid.split("-").pop() : "",
        transactionType: "GOODS_SERVICES",
        pspReference: pspReference,
        merchantReference: saleTransactionId || "",
        paymentMethod: card.brand,
        paymentMethodVariant: card.brand,
        cardScheme: card.brand,
        cardType: card.brand,
        cardBin: card.bin,
        cardSummary: card.last4,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        issuerCountry: card.issuerCountry,
        fundingSource: card.fundingSource,
        posEntryMode: card.entryMode,
        authCode: String(Math.floor(100000 + Math.random() * 900000)),
        posAuthAmountValue: value,
        posAuthAmountCurrency: amountsReq.Currency,
        posOriginalAmountValue: value,
        "posadditionalamounts.originalAmountValue": value,
        "posadditionalamounts.originalAmountCurrency": amountsReq.Currency,
        posAmountCashbackValue: "0",
        posAmountGratuityValue: "0",
        iso8601TxDate: now,
        txdate: now.slice(8, 10) + "-" + now.slice(5, 7) + "-" + now.slice(0, 4),
        txtime: now.slice(11, 19),
    };
    return new URLSearchParams(fields).toString();
}

/**
 * Fills in a PaymentResponse from its PaymentRequest.
 */
function buildPaymentResponse(response, request, card) {
    const paymentRequest = request?.SaleToPOIRequest?.PaymentRequest;
    const paymentResponse = response?.SaleToPOIResponse?.PaymentResponse;
    if (!paymentRequest || !paymentResponse) {
        return;
    }

    const now = new Date().toISOString();
    const pspReference = newPspReference();
    const poiid = request.SaleToPOIRequest.MessageHeader?.POIID;
    const amountsReq = paymentRequest.PaymentTransaction?.AmountsReq;
    const saleTransactionId = paymentRequest.SaleData?.SaleTransactionID;

    // The sale's own transaction ID comes back unchanged.
    if (saleTransactionId) {
        paymentResponse.SaleData = { ...paymentResponse.SaleData, SaleTransactionID: { ...saleTransactionId } };
    }

    // A new transaction on the terminal.
    paymentResponse.POIData = {
        ...paymentResponse.POIData,
        POITransactionID: { TimeStamp: now, TransactionID: poiTransactionId(pspReference) },
    };

    const result = paymentResponse.PaymentResult;
    if (result?.PaymentAcquirerData) {
        result.PaymentAcquirerData.AcquirerTransactionID = { TimeStamp: now, TransactionID: pspReference };
        if (poiid) {
            result.PaymentAcquirerData.AcquirerPOIID = poiid;
        }
    }

    if (paymentResponse.Response?.Result !== "Success") {
        // A refused payment keeps its recorded refusal reason, and gets its own PSP reference.
        const additional = new URLSearchParams(paymentResponse.Response?.AdditionalResponse || "");
        additional.set("pspReference", pspReference);
        paymentResponse.Response.AdditionalResponse = additional.toString();
        return;
    }

    // An approved payment is authorised for exactly the requested amount, on the card.
    if (result && amountsReq) {
        result.AmountsResp = { AuthorizedAmount: amountsReq.RequestedAmount, Currency: amountsReq.Currency };
        result.PaymentInstrumentData = {
            PaymentInstrumentType: "Card",
            CardData: {
                PaymentBrand: card.brand,
                MaskedPan: `${card.bin} **** ${card.last4}`,
                CardCountryCode: card.countryCode,
                EntryMode: [card.entryMode],
                SensitiveCardData: { ExpiryDate: card.expiryMonth + card.expiryYear.slice(2) },
            },
        };
        paymentResponse.Response.AdditionalResponse = approvedAdditionalResponse({
            pspReference,
            amountsReq,
            saleTransactionId: saleTransactionId?.TransactionID,
            poiid,
            card,
            now,
        });
    }
}

/**
 * Fills in a ReversalResponse from its ReversalRequest.
 */
function buildReversalResponse(response, request) {
    const reversalRequest = request?.SaleToPOIRequest?.ReversalRequest;
    const reversalResponse = response?.SaleToPOIResponse?.ReversalResponse;
    if (!reversalRequest || !reversalResponse) {
        return;
    }

    const now = new Date().toISOString();
    const pspReference = newPspReference();
    reversalResponse.POIData = {
        ...reversalResponse.POIData,
        POITransactionID: { TimeStamp: now, TransactionID: poiTransactionId(pspReference) },
    };
    if (reversalRequest.ReversedAmount !== undefined) {
        reversalResponse.ReversedAmount = reversalRequest.ReversedAmount;
    }
    if (reversalResponse.Response?.Result === "Success") {
        const additional = new URLSearchParams({ pspReference });
        const original = reversalRequest.OriginalPOITransaction?.POITransactionID?.TransactionID;
        if (original) {
            // The PSP reference of the reversed payment: the part after the tender reference.
            additional.set("originalPspReference", original.split(".").pop());
        }
        reversalResponse.Response.AdditionalResponse = additional.toString();
    }
}

/**
 * Returns the response for `request`, built from the canned `template` (left unchanged).
 * @param {Object} template - The recorded response JSON.
 * @param {Object} request - The request body.
 * @param {Object} [card] - The card an approved payment is made with.
 * @returns {Object}
 */
function buildResponse(template, request, card = DEFAULT_CARD) {
    const response = structuredClone(template);
    echoHeader(response, request);
    buildPaymentResponse(response, request, card);
    buildReversalResponse(response, request);
    return response;
}

module.exports = { buildResponse, newPspReference, DEFAULT_CARD };
