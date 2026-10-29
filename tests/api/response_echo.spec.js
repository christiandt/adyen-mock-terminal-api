// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { minorUnits } = require('../../src/services/responseBuilder');

const payloads = path.join(__dirname, '../../public/payloads');
const load = (file) => JSON.parse(fs.readFileSync(path.join(payloads, file), 'utf-8'));

/**
 * A payment request for `amount` `currency`, with its own ServiceID, SaleID, POIID and sale transaction ID.
 */
function paymentRequest(amount, currency = 'NOK') {
  const body = load('payment/paymentRequest.json');
  const id = Date.now().toString(36);
  body.SaleToPOIRequest.MessageHeader.ServiceID = `svc${id}`.slice(0, 10);
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.MessageHeader.POIID = 'S1F2-000158234567890';
  body.SaleToPOIRequest.PaymentRequest.SaleData.SaleTransactionID = { TransactionID: `order-175-${id}`, TimeStamp: new Date().toISOString() };
  body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq = { Currency: currency, RequestedAmount: amount };
  return body;
}

/**
 * Sends `body` to /sync and enters a PIN on the terminal screen once the payment waits for it.
 */
async function pay(request, body) {
  const pending = request.post('/sync', { data: body });
  await expect.poll(async () => (await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');
  for (let i = 0; i < 4; i++) {
    await request.post('/user-interaction/enter-pin');
  }
  await request.post('/user-interaction/confirm-button');
  return (await pending).json();
}

test.describe.configure({ mode: 'serial' });

test('Payment - response echoes the request header and amount', async ({ request }) => {
  const body = paymentRequest(667.5);
  const response = await pay(request, body);

  const header = response.SaleToPOIResponse.MessageHeader;
  expect(header.ServiceID).toBe(body.SaleToPOIRequest.MessageHeader.ServiceID);
  expect(header.SaleID).toBe('FloristIT-kasse-1');
  expect(header.POIID).toBe('S1F2-000158234567890');

  const payment = response.SaleToPOIResponse.PaymentResponse;
  expect(payment.Response.Result).toBe('Success');
  expect(payment.PaymentResult.AmountsResp).toEqual({ AuthorizedAmount: 667.5, Currency: 'NOK' });
  expect(payment.SaleData.SaleTransactionID).toEqual(body.SaleToPOIRequest.PaymentRequest.SaleData.SaleTransactionID);
  expect(payment.PaymentResult.PaymentAcquirerData.AcquirerPOIID).toBe('S1F2-000158234567890');
});

test('Payment - approved payment carries card details and a PSP reference', async ({ request }) => {
  const response = await pay(request, paymentRequest(1234.85));
  const payment = response.SaleToPOIResponse.PaymentResponse;

  const additional = new URLSearchParams(payment.Response.AdditionalResponse);
  const psp = additional.get('pspReference');
  expect(psp).toMatch(/^[A-Z0-9]{16}$/);
  expect(additional.get('paymentMethod')).toBe('visa');
  expect(additional.get('cardSummary')).toBe('1111');
  expect(additional.get('posAuthAmountValue')).toBe('123485');
  expect(additional.get('posAuthAmountCurrency')).toBe('NOK');
  expect(additional.get('merchantReference')).toMatch(/^order-175-/);

  // "<tender reference>.<PSP reference>", like Adyen's "BV0q001765198054002.CWBC43ZX2VTFWR82".
  expect(payment.PaymentResult.PaymentAcquirerData.AcquirerTransactionID.TransactionID).toBe(psp);
  expect(payment.POIData.POITransactionID.TransactionID).toMatch(new RegExp(`^[A-Za-z0-9]{4}00\\d{10}\\d{3}\\.${psp}$`));

  const card = payment.PaymentResult.PaymentInstrumentData.CardData;
  expect(card.PaymentBrand).toBe('visa');
  expect(card.MaskedPan).toBe('411111 **** 1111');
});

test('Payment - every payment gets its own PSP reference', async ({ request }) => {
  const first = await pay(request, paymentRequest(100));
  const second = await pay(request, paymentRequest(100));
  const psp = (r) => r.SaleToPOIResponse.PaymentResponse.PaymentResult.PaymentAcquirerData.AcquirerTransactionID.TransactionID;
  expect(psp(first)).not.toBe(psp(second));
});

test('Payment - a refused payment keeps its refusal reason and echoes the request', async ({ request }) => {
  const body = paymentRequest(1.24);
  const response = await pay(request, body);
  const payment = response.SaleToPOIResponse.PaymentResponse;

  expect(response.SaleToPOIResponse.MessageHeader.ServiceID).toBe(body.SaleToPOIRequest.MessageHeader.ServiceID);
  expect(payment.Response.Result).toBe('Failure');
  expect(payment.Response.ErrorCondition).toBe('Refusal');
  const additional = new URLSearchParams(payment.Response.AdditionalResponse);
  expect(additional.get('refusalReason')).toBe('210 Not enough balance');
  expect(payment.PaymentResult.PaymentAcquirerData.AcquirerTransactionID.TransactionID).toMatch(/^[A-Z0-9]{16}$/);
  expect(payment.PaymentResult.AmountsResp).toBeUndefined();
});

test('Reversal - echoes the header and gets its own PSP reference', async ({ request }) => {
  const payment = await pay(request, paymentRequest(250));
  const original = payment.SaleToPOIResponse.PaymentResponse.POIData.POITransactionID;

  const body = load('reversal/reversalRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = 'rev0000001';
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.ReversalRequest.OriginalPOITransaction.POITransactionID = original;
  const response = await (await request.post('/sync', { data: body })).json();

  expect(response.SaleToPOIResponse.MessageHeader.ServiceID).toBe('rev0000001');
  expect(response.SaleToPOIResponse.MessageHeader.SaleID).toBe('FloristIT-kasse-1');
  const reversal = response.SaleToPOIResponse.ReversalResponse;
  expect(reversal.Response.Result).toBe('Success');
  // The refund's own PSP reference is in POITransactionID, not the reversed payment's.
  const refund = reversal.POIData.POITransactionID.TransactionID;
  expect(refund).toMatch(/\.[A-Z0-9]{16}$/);
  expect(refund).not.toBe(original.TransactionID);
});

test('Canned payloads are not changed by a request', async ({ request }) => {
  await pay(request, paymentRequest(42));
  // The stock request (1.00 EUR) is still answered with its own amount.
  const response = await pay(request, load('payment/paymentRequest.json'));
  expect(response.SaleToPOIResponse.PaymentResponse.PaymentResult.AmountsResp).toEqual({ AuthorizedAmount: 1, Currency: 'EUR' });
  expect(response.SaleToPOIResponse.MessageHeader.ServiceID).toBe('1234567890AB');
});

test('Payment - amounts are in the currency\'s minor units', async ({ request }) => {
  const response = await pay(request, paymentRequest(100, 'JPY'));
  const additional = new URLSearchParams(response.SaleToPOIResponse.PaymentResponse.Response.AdditionalResponse);
  expect(additional.get('posAuthAmountValue')).toBe('100');
  expect(additional.get('posAuthAmountCurrency')).toBe('JPY');
});

test('minorUnits follows Adyen\'s currency table', () => {
  expect(minorUnits(667.5, 'NOK')).toBe(66750);
  expect(minorUnits(100, 'JPY')).toBe(100);
  expect(minorUnits(1.234, 'BHD')).toBe(1234);
  expect(minorUnits(1000, 'IDR')).toBe(1000);
  // ISK has 0 decimals in ISO 4217, but 2 at Adyen.
  expect(minorUnits(500, 'ISK')).toBe(50000);
  expect(minorUnits(0.1 + 0.2, 'EUR')).toBe(30);
});
