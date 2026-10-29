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

// Currencies whose minor unit is not 2 decimals, from Adyen's currency table
// (https://docs.adyen.com/development-resources/currency-codes). Adyen's table is what
// counts, not ISO 4217: ISK, for one, has 2 decimals at Adyen.
const CURRENCY_DECIMALS = {
    BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
    CVE: 0, DJF: 0, GNF: 0, IDR: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
    RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
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

let tenderSequence = 0;

/**
 * The terminal's transaction ID, "<tender reference>.<PSP reference>" as Adyen documents it
 * (e.g. "BV0q001765198054002.CWBC43ZX2VTFWR82"). The tender reference is shaped like a
 * terminal's: four characters, "00", the Unix time in seconds and a three-digit counter.
 * @param {String} pspReference
 * @returns {String}
 */
function poiTransactionId(pspReference) {
    tenderSequence = (tenderSequence % 999) + 1;
    const seconds = Math.floor(Date.now() / 1000);
    return `MoCk00${seconds}${String(tenderSequence).padStart(3, "0")}.${pspReference}`;
}

/**
 * An amount in the currency's minor units, e.g. 667.5 NOK -> 66750, 100 JPY -> 100, 1.234 BHD -> 1234.
 * @param {Number} amount
 * @param {String} currency - ISO 4217 code.
 * @returns {Number}
 */
function minorUnits(amount, currency) {
    const decimals = CURRENCY_DECIMALS[String(currency).toUpperCase()] ?? 2;
    return Math.round(Number(amount) * 10 ** decimals);
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
 * The AdditionalResponse of an approved payment, as form-encoded key-value pairs: the format
 * Adyen uses when the request's SaleToAcquirerData is key-value pairs or absent. (A request
 * with Base64-encoded JSON SaleToAcquirerData gets Base64-encoded JSON from Adyen; that is
 * not supported here, because Adyen does not document the decoded object's structure.)
 * Only keys Adyen documents are used.
 */
function approvedAdditionalResponse({ pspReference, amountsReq, saleTransactionId, poiid, card }) {
    const value = String(minorUnits(amountsReq.RequestedAmount, amountsReq.Currency));
    const fields = {
        tid: poiid ? poiid.split("-").pop() : "",
        transactionType: "GOODS_SERVICES",
        pspReference: pspReference,
        merchantReference: saleTransactionId || "",
        paymentMethod: card.brand,
        paymentMethodVariant: card.brand,
        cardBin: card.bin,
        cardSummary: card.last4,
        expiryDate: `${Number(card.expiryMonth)}/${card.expiryYear}`,
        issuerCountry: card.issuerCountry,
        fundingSource: card.fundingSource,
        authCode: String(Math.floor(100000 + Math.random() * 900000)),
        posAuthAmountValue: value,
        posAuthAmountCurrency: amountsReq.Currency,
        posOriginalAmountValue: value,
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
        // A refused payment keeps its recorded AdditionalResponse (message and refusal reason);
        // its PSP reference is in the transaction IDs above, as in the recordings.
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
    // The refund's own PSP reference is in POITransactionID. Its AdditionalResponse (with
    // posOriginalAmountValue, the reversed payment's amount) needs that payment, which the
    // mock does not keep yet, so the recorded one is returned.
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

module.exports = { buildResponse, minorUnits, newPspReference, DEFAULT_CARD };
