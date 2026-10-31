/**
 * Builds the response to a request from its canned payload.
 *
 * The payloads in `/public/payloads` are recorded responses, so on their own every
 * response carries the same IDs and amount (1.00 EUR). A terminal answers the request
 * it was sent: the same ServiceID, SaleID and POIID in the header, the requested amount
 * and currency, the sale's own transaction ID, and a new transaction (PSP) reference.
 * This fills those in, so an integration can match a response to its request.
 */

const { resolveCard, DEFAULT_CARD_ID } = require("./cards");

// The card a successful payment is made with unless the terminal setting says otherwise:
// Adyen's Visa test card.
const DEFAULT_CARD = resolveCard(DEFAULT_CARD_ID);

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
 * A new tender reference, shaped like a terminal's: four characters, "00", the Unix time in
 * seconds and a three-digit counter (cf. Adyen's "BV0q001765198054002").
 * @returns {String}
 */
function newTenderReference() {
    tenderSequence = (tenderSequence % 999) + 1;
    const seconds = Math.floor(Date.now() / 1000);
    return `MoCk00${seconds}${String(tenderSequence).padStart(3, "0")}`;
}

/**
 * The terminal's transaction ID, "<tender reference>.<PSP reference>" as Adyen documents it
 * (e.g. "BV0q001765198054002.CWBC43ZX2VTFWR82").
 * @param {String} pspReference
 * @param {String} [tenderReference] - The payment's tender reference; a new one if omitted.
 * @returns {String}
 */
function poiTransactionId(pspReference, tenderReference = newTenderReference()) {
    return `${tenderReference}.${pspReference}`;
}

/**
 * How a payment that did not reach the PIN confirmation ends, from the `abortPayment` payload:
 * - aborted by an AbortRequest: ErrorCondition "Aborted" (as Adyen's "Cancel a transaction" says);
 * - cancelled on the terminal: "Cancel", with Adyen's refusal reason "Shopper cancelled";
 * - timed out waiting for the shopper: "Cancel", which Adyen uses for device time-outs.
 */
const ENDINGS = {
    ABORTED: { ErrorCondition: "Aborted", AdditionalResponse: "message=104%20Merchant%20cancelled" },
    CANCELLED: { ErrorCondition: "Cancel", AdditionalResponse: "refusalReason=Shopper%20cancelled&message=CANCELLED" },
    TIMED_OUT: { ErrorCondition: "Cancel" },
};

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
 * An amount in the currency's major units from its minor units, e.g. 66750 NOK -> 667.5,
 * 100 ISK -> 1 (ISK has 2 decimals at Adyen), 100 JPY -> 100.
 * @param {Number} value - Minor units.
 * @param {String} currency - ISO 4217 code.
 * @returns {Number}
 */
function fromMinorUnits(value, currency) {
    const decimals = CURRENCY_DECIMALS[String(currency).toUpperCase()] ?? 2;
    return Number(value) / 10 ** decimals;
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
        paymentMethodVariant: card.variant,
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
 * The CardData of a payment made with `card`.
 */
function cardDataFor(card) {
    return {
        PaymentBrand: card.brand,
        MaskedPan: `${card.bin} **** ${card.last4}`,
        CardCountryCode: card.countryCode,
        EntryMode: [card.entryMode],
        SensitiveCardData: { ExpiryDate: card.expiryMonth + card.expiryYear.slice(2) },
    };
}

/**
 * Fills in a PaymentResponse from its PaymentRequest.
 */
function buildPaymentResponse(response, request, card, { tenderReference, outcome } = {}) {
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
        POITransactionID: { TimeStamp: now, TransactionID: poiTransactionId(pspReference, tenderReference) },
    };

    const result = paymentResponse.PaymentResult;
    if (result?.PaymentAcquirerData) {
        result.PaymentAcquirerData.AcquirerTransactionID = { TimeStamp: now, TransactionID: pspReference };
        if (poiid) {
            result.PaymentAcquirerData.AcquirerPOIID = poiid;
        }
    }

    const ending = ENDINGS[outcome];
    if (ending && paymentResponse.Response) {
        paymentResponse.Response = { Result: "Failure", ...ending };
    }

    if (paymentResponse.Response?.Result !== "Success") {
        // A refused payment keeps its recorded AdditionalResponse (message and refusal reason);
        // its PSP reference is in the transaction IDs above, as in the recordings. A card that was
        // read and refused is the terminal's card; an aborted or cancelled payment read none.
        const cardData = result?.PaymentInstrumentData?.CardData;
        if (cardData?.PaymentBrand) {
            Object.assign(cardData, cardDataFor(card));
        }
        return;
    }

    // An approved payment is authorised for exactly the requested amount, on the card.
    if (result && amountsReq) {
        result.AmountsResp = { AuthorizedAmount: amountsReq.RequestedAmount, Currency: amountsReq.Currency };
        result.PaymentInstrumentData = { PaymentInstrumentType: "Card", CardData: cardDataFor(card) };
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
function buildReversalResponse(response, request, findPayment) {
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
    // The refund's own PSP reference is in POITransactionID. Its AdditionalResponse holds
    // posOriginalAmountValue: the reversed payment's amount, in minor units.
    const original = reversalRequest.OriginalPOITransaction?.POITransactionID?.TransactionID;
    const payment = original && findPayment ? findPayment(original) : undefined;
    const amounts = payment?.PaymentResponse?.PaymentResult?.AmountsResp;
    if (reversalResponse.Response?.Result === "Success") {
        reversalResponse.Response.AdditionalResponse = amounts
            ? new URLSearchParams({ posOriginalAmountValue: String(minorUnits(amounts.AuthorizedAmount, amounts.Currency)) }).toString()
            : "";
    }
}

/**
 * Returns the response for `request`, built from the canned `template` (left unchanged).
 * @param {Object} template - The recorded response JSON.
 * @param {Object} request - The request body.
 * @param {Object} [options]
 * @param {Object} [options.card] - The card an approved payment is made with.
 * @param {String} [options.tenderReference] - The payment's tender reference.
 * @param {String} [options.outcome] - How the payment ended, when not with a PIN: ABORTED, CANCELLED or TIMED_OUT.
 * @param {Function} [options.findPayment] - Looks up a payment's SaleToPOIResponse by POITransactionID.
 * @returns {Object}
 */
function buildResponse(template, request, { card = DEFAULT_CARD, tenderReference, outcome, findPayment } = {}) {
    const response = structuredClone(template);
    echoHeader(response, request);
    buildPaymentResponse(response, request, card, { tenderReference, outcome });
    buildReversalResponse(response, request, findPayment);
    return response;
}

module.exports = { buildResponse, minorUnits, fromMinorUnits, newPspReference, newTenderReference, DEFAULT_CARD };
