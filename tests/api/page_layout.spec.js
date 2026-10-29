// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const payloads = path.join(__dirname, '../../public/payloads');
const load = (file) => JSON.parse(fs.readFileSync(path.join(payloads, file), 'utf-8'));

function paymentRequest(amount, id) {
  const body = load('payment/paymentRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = id;
  body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq = { Currency: 'NOK', RequestedAmount: amount };
  return body;
}

const settings = (request, data) => request.post('/user-interaction/settings', { data });

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  await settings(request, { autoConfirm: false, autoConfirmDelayMs: 1000, card: 'visa', cardLast4: null });
});

test('Messages - each exchange is logged, pending until answered; ?version skips an unchanged list', async ({ request }) => {
  await request.post('/user-interaction/clear-codeblocks-button');
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 1500 });

  const pending = request.post('/sync', { data: paymentRequest(250, 'log0000001') });
  await expect.poll(async () => (await (await request.get('/user-interaction/messages')).json()).messages.length).toBe(1);
  const during = await (await request.get('/user-interaction/messages')).json();
  expect(during.messages[0]).toMatchObject({ done: false, response: null });
  expect(during.messages[0].request.SaleToPOIRequest.MessageHeader.ServiceID).toBe('log0000001');

  await pending;
  const after = await (await request.get('/user-interaction/messages')).json();
  expect(after.version).toBeGreaterThan(during.version);
  expect(after.messages[0].done).toBe(true);
  expect(after.messages[0].response.SaleToPOIResponse.PaymentResponse.Response.Result).toBe('Success');

  const unchanged = await (await request.get(`/user-interaction/messages?version=${after.version}`)).json();
  expect(unchanged).toEqual({ version: after.version });

  await request.post('/user-interaction/clear-codeblocks-button');
  expect((await (await request.get('/user-interaction/messages')).json()).messages).toEqual([]);
});

test('Messages - an abort is logged with no response body', async ({ request }) => {
  await request.post('/user-interaction/clear-codeblocks-button');
  await request.post('/sync', { data: load('abortPayment/abortPaymentRequest.json') });
  const { messages } = await (await request.get('/user-interaction/messages')).json();
  expect(messages[0]).toMatchObject({ done: true, response: null });
});

test('State - the payment in progress and how the last one ended', async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 1500, card: 'mc' });
  const pending = request.post('/sync', { data: paymentRequest(667.5, 'state00001') });
  await expect.poll(async () => (await (await request.get('/user-interaction/get-state')).json()).state).toBe('BUSY');
  expect((await (await request.get('/user-interaction/get-state')).json()).payment).toEqual({ amount: 667.5, currency: 'NOK' });

  await pending;
  const after = await (await request.get('/user-interaction/get-state')).json();
  expect(after.state).toBe('READY');
  expect(after.payment).toBeNull();
  expect(after.lastOutcome).toMatchObject({ result: 'Success', amount: 667.5, currency: 'NOK', brand: 'mc', last4: '4444' });
});

test('Page - fits one 1280x800 screen; the device panel does not cover the keypad', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const height = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
  expect(height[0]).toBeLessThanOrEqual(height[1]);
  for (const name of ['1', '✓', 'Cancel', 'Correct']) {
    await page.getByRole('button', { name, exact: true }).click({ trial: true });
  }
  await expect(page.getByText('Connect your POS')).toBeVisible();
});

test('Page - the screen shows the amount, then the outcome; the message opens with its JSON', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const pending = request.post('/sync', { data: paymentRequest(1234.5, 'page000001') });
  await expect(page.locator('#screen-amount')).not.toBeEmpty();
  await expect(page.locator('text=/Enter your pin/')).toBeVisible();
  for (const digit of ['1', '2', '3', '4']) {
    await page.getByRole('button', { name: digit, exact: true }).click();
  }
  await page.getByRole('button', { name: '✓' }).click();
  await pending;
  await expect(page.locator('#screen')).toHaveText('Approved');
  await expect(page.locator('.message[open]').first()).toContainText('"Result": "Success"');
});

test('Page - the messages pane and the device panel can be hidden', async ({ page }) => {
  await page.goto('/');
  await page.locator('#messages-toggle').click();
  await expect(page.locator('#messages-body')).toBeHidden();
  await page.locator('#messages-toggle').click();
  await expect(page.locator('#messages-body')).toBeVisible();

  await page.locator('#device-panel-toggle').click();
  await expect(page.locator('#device-panel-body')).toBeHidden();
  await page.locator('#device-panel-toggle').click();
  await expect(page.locator('#device-panel-body')).toBeVisible();
});
