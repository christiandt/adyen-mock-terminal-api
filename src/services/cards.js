/**
 * The cards an approved payment can be made with (the terminal setting `card`).
 *
 * `brand` (PaymentBrand / paymentMethod) and `variant` (paymentMethodVariant) are the identifiers
 * in Adyen's list (https://docs.adyen.com/development-resources/paymentmethodvariant). That list
 * gives BankAxept only as a variant; its paymentMethod is assumed to be the same, "bankaxept".
 * The card numbers are illustrative, except Adyen's Visa test card (411111...1111).
 */
const CARDS = {
    visa: { label: "Visa (credit)", brand: "visa", variant: "visacredit", bin: "411111", last4: "1111", fundingSource: "CREDIT" },
    visadebit: { label: "Visa (debit)", brand: "visa", variant: "visadebit", bin: "457173", last4: "0004", fundingSource: "DEBIT" },
    mc: { label: "Mastercard (credit)", brand: "mc", variant: "mc", bin: "555544", last4: "4444", fundingSource: "CREDIT" },
    mcdebit: { label: "Mastercard (debit)", brand: "mc", variant: "mcdebit", bin: "520082", last4: "0008", fundingSource: "DEBIT" },
    maestro: { label: "Maestro", brand: "maestro", variant: "maestro", bin: "600007", last4: "7003", fundingSource: "DEBIT" },
    amex: { label: "American Express", brand: "amex", variant: "amex", bin: "370000", last4: "0002", fundingSource: "CREDIT" },
    vpay: { label: "V Pay", brand: "vpay", variant: "vpay", bin: "482000", last4: "0006", fundingSource: "DEBIT" },
    bankaxept: { label: "BankAxept", brand: "bankaxept", variant: "bankaxept", bin: "672000", last4: "0016", fundingSource: "DEBIT" },
};

// Shared by every card.
const COMMON = {
    expiryMonth: "03",
    expiryYear: "2030",
    countryCode: "578",
    issuerCountry: "NO",
    entryMode: "ICC",
};

const DEFAULT_CARD_ID = "visa";

/**
 * Whether `id` names one of the presets (not an inherited property such as "constructor").
 * @param {*} id
 * @returns {Boolean}
 */
function isCardId(id) {
    return typeof id === "string" && Object.hasOwn(CARDS, id);
}

/**
 * The card for a preset, with its last four digits replaced if `last4` is given.
 * @param {String} id - A key of CARDS.
 * @param {String|null} [last4] - Four digits, or null for the preset's own.
 * @returns {Object}
 */
function resolveCard(id, last4 = null) {
    const { label, ...card } = CARDS[isCardId(id) ? id : DEFAULT_CARD_ID];
    return { ...COMMON, ...card, last4: last4 || card.last4 };
}

/**
 * The presets for a menu: [{ id, label }].
 */
function listCards() {
    return Object.entries(CARDS).map(([id, card]) => ({ id, label: card.label }));
}

module.exports = { CARDS, DEFAULT_CARD_ID, isCardId, resolveCard, listCards };
