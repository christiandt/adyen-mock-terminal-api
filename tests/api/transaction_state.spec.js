// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const payloads = path.join(__dirname, '../../public/payloads');
const load = (file) => JSON.parse(fs.readFileSync(path.join(payloads, file), 'utf-8'));

let counter = 0;
const serviceId = () => `s${Date.now().toString(36)}${counter++}`.slice(-10);

function paymentRequest(amount, id = serviceId()) {
  const body = load('payment/paymentRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = id;
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq = { Currency: 'NOK', RequestedAmount: amount };
  return body;
}

function statusRequest(reference) {
  const body = load('paymentTransactionStatus/paymentTransactionStatusRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = serviceId();
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  if (reference) {
    body.SaleToPOIRequest.TransactionStatusRequest.MessageReference = reference;
  } else {
    delete body.SaleToPOIRequest.TransactionStatusRequest.MessageReference;
  }
  return body;
}

function abortRequest(id) {
  const body = load('abortPayment/abortPaymentRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = serviceId();
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.AbortRequest.MessageReference = { MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id };
  return body;
}

async function waitUntilBusy(request) {
  await expect.poll(async () => (await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');
}

async function enterPin(request) {
  for (let i = 0; i < 4; i++) {
    await request.post('/user-interaction/enter-pin');
  }
  await request.post('/user-interaction/confirm-button');
}

async function pay(request, body) {
  const pending = request.post('/sync', { data: body });
  await waitUntilBusy(request);
  await enterPin(request);
  return (await pending).json();
}

const sync = async (request, body) => (await request.post('/sync', { data: body })).json();

test.describe.configure({ mode: 'serial' });

test('Abort - answered with an empty 200; the payment ends as Aborted', async ({ request }) => {
  const id = serviceId();
  const pending = request.post('/sync', { data: paymentRequest(300, id) });
  await waitUntilBusy(request);

  const abort = await request.post('/sync', { data: abortRequest(id) });
  expect(abort.status()).toBe(200);
  expect(await abort.text()).toBe('');

  const response = await (await pending).json();
  expect(response.SaleToPOIResponse.MessageHeader.ServiceID).toBe(id);
  expect(response.SaleToPOIResponse.MessageHeader.MessageCategory).toBe('Payment');
  expect(response.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Aborted' });
  expect((await (await request.get('/user-interaction/get-state')).json()).state).toBe('READY');
});

test('Abort - for another payment leaves this one running', async ({ request }) => {
  const id = serviceId();
  const pending = request.post('/sync', { data: paymentRequest(300, id) });
  await waitUntilBusy(request);

  const abort = await request.post('/sync', { data: abortRequest('not-this-one') });
  expect(abort.status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect((await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');

  await enterPin(request);
  const response = await (await pending).json();
  expect(response.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
});

test('Cancel on the terminal - the payment ends as Cancel, shopper cancelled', async ({ request }) => {
  const pending = request.post('/sync', { data: paymentRequest(300) });
  await waitUntilBusy(request);
  await request.post('/user-interaction/cancel-button');

  const response = await (await pending).json();
  const result = response.SaleToPOIResponse.PaymentResponse.Response;
  expect(result).toMatchObject({ Result: 'Failure', ErrorCondition: 'Cancel' });
  expect(new URLSearchParams(result.AdditionalResponse).get('refusalReason')).toBe('Shopper cancelled');
});

test('Time-out - the payment ends as Cancel (device time-out)', async ({ request }) => {
  const seconds = parseInt(process.env.PIN_TIMEOUT_SECONDS || '', 10);
  test.skip(!(seconds > 0 && seconds <= 30), 'Needs the server started with PIN_TIMEOUT_SECONDS of at most 30.');
  test.setTimeout((seconds + 30) * 1000);

  const response = await sync(request, paymentRequest(300));
  expect(response.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Cancel' });
  expect(response.SaleToPOIResponse.PaymentResponse.Response.AdditionalResponse).toBeUndefined();
});

test('Busy - another payment while one is in progress is answered Busy', async ({ request }) => {
  const pending = request.post('/sync', { data: paymentRequest(300) });
  await waitUntilBusy(request);

  const busy = await sync(request, paymentRequest(100));
  expect(busy.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Busy' });

  await enterPin(request);
  await pending;
});

test('Transaction status - InProgress while the payment waits, then its result', async ({ request }) => {
  const id = serviceId();
  const reference = { MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id };
  const pending = request.post('/sync', { data: paymentRequest(667.5, id) });
  await waitUntilBusy(request);

  const during = await sync(request, statusRequest(reference));
  const duringResponse = during.SaleToPOIResponse.TransactionStatusResponse;
  expect(during.SaleToPOIResponse.MessageHeader.MessageCategory).toBe('TransactionStatus');
  expect(duringResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'InProgress' });
  const tenderReference = new URLSearchParams(duringResponse.Response.AdditionalResponse).get('tenderReference');
  expect(tenderReference).toMatch(/^[A-Za-z0-9]{4}00\d{13}$/);

  await enterPin(request);
  const payment = await (await pending).json();
  const transactionId = payment.SaleToPOIResponse.PaymentResponse.POIData.POITransactionID.TransactionID;
  expect(transactionId.startsWith(`${tenderReference}.`)).toBe(true);

  const after = await sync(request, statusRequest(reference));
  const status = after.SaleToPOIResponse.TransactionStatusResponse;
  expect(status.Response.Result).toBe('Success');
  expect(status.MessageReference).toEqual(reference);
  expect(status.RepeatedMessageResponse.MessageHeader.ServiceID).toBe(id);
  expect(status.RepeatedMessageResponse.MessageHeader.MessageCategory).toBe('Payment');
  expect(status.RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse)
    .toEqual(payment.SaleToPOIResponse.PaymentResponse);
});

test('Transaction status - a declined payment is found with its refusal', async ({ request }) => {
  const id = serviceId();
  await pay(request, paymentRequest(1.24, id));
  const after = await sync(request, statusRequest({ MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id }));
  const status = after.SaleToPOIResponse.TransactionStatusResponse;
  expect(status.Response.Result).toBe('Success');
  expect(status.RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse.Response)
    .toMatchObject({ Result: 'Failure', ErrorCondition: 'Refusal' });
});

test('Transaction status - NotFound for an unknown transaction or no MessageReference', async ({ request }) => {
  const unknown = await sync(request, statusRequest({ MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: 'nope000001' }));
  expect(unknown.SaleToPOIResponse.TransactionStatusResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'NotFound' });
  expect(new URLSearchParams(unknown.SaleToPOIResponse.TransactionStatusResponse.Response.AdditionalResponse).get('message'))
    .toContain('Message not found');

  const missing = await sync(request, statusRequest(null));
  expect(missing.SaleToPOIResponse.TransactionStatusResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'NotFound' });
});

test('Reversal - posOriginalAmountValue is the reversed payment\'s amount; its status can be looked up', async ({ request }) => {
  const payment = await pay(request, paymentRequest(667.5));
  const original = payment.SaleToPOIResponse.PaymentResponse.POIData.POITransactionID;

  const body = load('reversal/reversalRequest.json');
  const id = serviceId();
  body.SaleToPOIRequest.MessageHeader.ServiceID = id;
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.ReversalRequest.OriginalPOITransaction.POITransactionID = original;
  const reversal = await sync(request, body);
  const additional = new URLSearchParams(reversal.SaleToPOIResponse.ReversalResponse.Response.AdditionalResponse);
  expect(additional.get('posOriginalAmountValue')).toBe('66750');

  const status = await sync(request, statusRequest({ MessageCategory: 'Reversal', SaleID: 'FloristIT-kasse-1', ServiceID: id }));
  expect(status.SaleToPOIResponse.TransactionStatusResponse.Response.Result).toBe('Success');
  expect(status.SaleToPOIResponse.TransactionStatusResponse.RepeatedMessageResponse.RepeatedResponseMessageBody.ReversalResponse)
    .toEqual(reversal.SaleToPOIResponse.ReversalResponse);
});

test('Abort - a payment started right after the abort keeps its own outcome', async ({ request }) => {
  const aborted = serviceId();
  const first = request.post('/sync', { data: paymentRequest(300, aborted) });
  await waitUntilBusy(request);

  // The till starts the next payment as soon as the abort is answered.
  await request.post('/sync', { data: abortRequest(aborted) });
  const nextId = serviceId();
  const next = request.post('/sync', { data: paymentRequest(150, nextId) });
  await waitUntilBusy(request);
  await enterPin(request);

  const firstResponse = await (await first).json();
  const nextResponse = await (await next).json();
  expect(firstResponse.SaleToPOIResponse.PaymentResponse.Response.ErrorCondition).toBe('Aborted');
  expect(nextResponse.SaleToPOIResponse.MessageHeader.ServiceID).toBe(nextId);
  expect(nextResponse.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
});

test('Store - reusing a SaleID and ServiceID does not grow the payment index', () => {
  const store = require('../../src/services/transactionStore');
  store.clear();
  const request = paymentRequest(100, 'reused0001');
  for (let i = 0; i < 1005; i++) {
    const response = { SaleToPOIResponse: { PaymentResponse: { POIData: { POITransactionID: { TransactionID: `MoCk00${i}.PSP${i}` } } } } };
    store.save('Payment', request, response);
  }
  expect(store.size()).toEqual({ references: 1, payments: 1 });
  expect(store.findPayment('MoCk001004.PSP1004')).toBeDefined();
  expect(store.findPayment('MoCk000.PSP0')).toBeUndefined();
});

test('Abort - the aborted payment can be looked up right after the abort is answered', async ({ request }) => {
  const id = serviceId();
  const pending = request.post('/sync', { data: paymentRequest(300, id) });
  await waitUntilBusy(request);

  await request.post('/sync', { data: abortRequest(id) });
  const status = await sync(request, statusRequest({ MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id }));
  const response = status.SaleToPOIResponse.TransactionStatusResponse;
  expect(response.Response.Result).toBe('Success');
  expect(response.RepeatedMessageResponse.RepeatedResponseMessageBody.PaymentResponse.Response.ErrorCondition).toBe('Aborted');
  await pending;
});
