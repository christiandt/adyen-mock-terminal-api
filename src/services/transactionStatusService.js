/**
 * Answers a TransactionStatusRequest from the transactions the terminal has handled, as Adyen
 * describes it (https://docs.adyen.com/point-of-sale/basic-tapi-integration/verify-transaction-status):
 * - the transaction ended: Result "Success", and the original response in
 *   RepeatedMessageResponse (its MessageHeader and RepeatedResponseMessageBody);
 * - it is still being processed: Result "Failure", ErrorCondition "InProgress";
 * - it is unknown, or the request has no MessageReference: Result "Failure", ErrorCondition "NotFound".
 */
const transactionStore = require("./transactionStore");

/**
 * The response header for `request`: a TransactionStatus response echoing its IDs.
 */
function responseHeader(request) {
    const header = request?.SaleToPOIRequest?.MessageHeader || {};
    return {
        ProtocolVersion: header.ProtocolVersion || "3.0",
        MessageClass: "Service",
        MessageCategory: "TransactionStatus",
        MessageType: "Response",
        ServiceID: header.ServiceID,
        SaleID: header.SaleID,
        POIID: header.POIID,
    };
}

function failure(request, reference, errorCondition, additionalResponse) {
    const body = { Response: { Result: "Failure", ErrorCondition: errorCondition, AdditionalResponse: additionalResponse } };
    if (reference) {
        body.MessageReference = reference;
    }
    return { SaleToPOIResponse: { MessageHeader: responseHeader(request), TransactionStatusResponse: body } };
}

/**
 * @param {Object} request - The TransactionStatusRequest body.
 * @returns {Object} - The TransactionStatusResponse body.
 */
function buildTransactionStatusResponse(request) {
    const reference = request?.SaleToPOIRequest?.TransactionStatusRequest?.MessageReference;
    const category = reference?.MessageCategory || "Payment";

    if (!reference?.SaleID || !reference?.ServiceID) {
        return failure(request, reference, "NotFound", new URLSearchParams({ message: "Message not found" }).toString());
    }

    const inProgress = transactionStore.getInProgress();
    if (category === "Payment" && inProgress
        && inProgress.saleId === reference.SaleID && inProgress.serviceId === reference.ServiceID) {
        // Adyen's InProgress response includes the payment's tender reference.
        return failure(request, reference, "InProgress", new URLSearchParams({ tenderReference: inProgress.tenderReference }).toString());
    }

    const found = transactionStore.find(reference.SaleID, reference.ServiceID);
    if (!found || found.category !== category) {
        const message = `Message not found: ${category}, ${reference.SaleID}, ${reference.ServiceID}`;
        return failure(request, reference, "NotFound", new URLSearchParams({ message }).toString());
    }

    const original = found.response.SaleToPOIResponse;
    const { MessageHeader, ...originalBody } = original;
    return {
        SaleToPOIResponse: {
            MessageHeader: responseHeader(request),
            TransactionStatusResponse: {
                MessageReference: { MessageCategory: category, SaleID: reference.SaleID, ServiceID: reference.ServiceID },
                Response: { Result: "Success" },
                RepeatedMessageResponse: {
                    MessageHeader: structuredClone(MessageHeader),
                    RepeatedResponseMessageBody: structuredClone(originalBody),
                },
            },
        },
    };
}

module.exports = { buildTransactionStatusResponse };
