// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const payloads = path.join(__dirname, '../../public/payloads');
const load = (file) => JSON.parse(fs.readFileSync(path.join(payloads, file), 'utf-8'));

let counter = 0;
const serviceId = () => `a${Date.now().toString(36)}${counter++}`.slice(-10);

function paymentRequest(amount, id = serviceId()) {
  const body = load('payment/paymentRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = id;
  body.SaleToPOIRequest.MessageHeader.SaleID = 'FloristIT-kasse-1';
  body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq = { Currency: 'NOK', RequestedAmount: amount };
  return body;
}

const settings = (request, data) => request.post('/user-interaction/settings', { data });

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  await settings(request, { autoConfirm: false, autoConfirmDelayMs: 1000, card: 'visa', cardLast4: null });
});

test('Settings - read and changed at runtime', async ({ request }) => {
  const initial = await (await request.get('/user-interaction/settings')).json();
  expect(initial).toEqual({ autoConfirm: false, autoConfirmDelayMs: 1000, card: 'visa', cardLast4: null });

  const changed = await settings(request, { autoConfirm: true, autoConfirmDelayMs: 250 });
  expect(changed.status()).toBe(200);
  expect(await changed.json()).toMatchObject({ autoConfirm: true, autoConfirmDelayMs: 250 });
  expect(await (await request.get('/user-interaction/settings')).json()).toMatchObject({ autoConfirm: true, autoConfirmDelayMs: 250 });
});

test('Settings - invalid values are refused and change nothing', async ({ request }) => {
  for (const data of [{ autoConfirm: 'yes' }, { autoConfirmDelayMs: -1 }, { autoConfirmDelayMs: 60001 }, { autoConfirmDelayMs: 1.5 }, { pin: '1234' }, { card: 'diners' }, { card: 'constructor' }, { card: 'toString' }, { card: ['visa'] }, { cardLast4: '12a4' }, { cardLast4: 1234 }]) {
    const response = await settings(request, data);
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBeTruthy();
  }
  expect(await (await request.get('/user-interaction/settings')).json()).toEqual({ autoConfirm: false, autoConfirmDelayMs: 1000, card: 'visa', cardLast4: null });
});

test('Auto-confirm - a payment is approved without entering a PIN', async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 200 });
  const started = Date.now();
  const response = await (await request.post('/sync', { data: paymentRequest(667.5) })).json();
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(response.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');
  expect(response.SaleToPOIResponse.PaymentResponse.PaymentResult.AmountsResp).toEqual({ AuthorizedAmount: 667.5, Currency: 'NOK' });
  expect((await (await request.get('/user-interaction/get-state')).json()).state).toBe('READY');
});

test('Auto-confirm - refusal amounts are still refused', async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 0 });
  const response = await (await request.post('/sync', { data: paymentRequest(1.25) })).json();
  expect(response.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Refusal' });
});

test('Auto-confirm - status and abort work during the delay', async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 5000 });
  const id = serviceId();
  const pending = request.post('/sync', { data: paymentRequest(300, id) });
  await expect.poll(async () => (await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');

  const status = load('paymentTransactionStatus/paymentTransactionStatusRequest.json');
  status.SaleToPOIRequest.MessageHeader.ServiceID = serviceId();
  status.SaleToPOIRequest.TransactionStatusRequest.MessageReference = { MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id };
  const during = await (await request.post('/sync', { data: status })).json();
  expect(during.SaleToPOIResponse.TransactionStatusResponse.Response.ErrorCondition).toBe('InProgress');

  const abort = load('abortPayment/abortPaymentRequest.json');
  abort.SaleToPOIRequest.MessageHeader.ServiceID = serviceId();
  abort.SaleToPOIRequest.AbortRequest.MessageReference = { MessageCategory: 'Payment', SaleID: 'FloristIT-kasse-1', ServiceID: id };
  await request.post('/sync', { data: abort });

  const response = await (await pending).json();
  expect(response.SaleToPOIResponse.PaymentResponse.Response.ErrorCondition).toBe('Aborted');
});

test('Auto-confirm - the checkbox on the page turns it on and off', async ({ page, request }) => {
  await page.goto('/');
  const checkbox = page.getByLabel('Auto-confirm PIN');
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  await expect.poll(async () => (await (await request.get('/user-interaction/settings')).json()).autoConfirm).toBe(true);

  await page.getByRole('button', { name: 'Clear' }).click();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('text=/PaymentResponse/')).toBeVisible();
  await expect(page.locator('text=/"Success"/')).toBeVisible();

  await checkbox.uncheck();
  await expect.poll(async () => (await (await request.get('/user-interaction/settings')).json()).autoConfirm).toBe(false);
});

test('Auto-confirm - a cancel on the terminal before the delay ends wins', async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 300 });
  const pending = request.post('/sync', { data: paymentRequest(300) });
  await expect.poll(async () => (await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');
  await request.post('/user-interaction/cancel-button');

  const response = await (await pending).json();
  expect(response.SaleToPOIResponse.PaymentResponse.Response).toMatchObject({ Result: 'Failure', ErrorCondition: 'Cancel' });
});
