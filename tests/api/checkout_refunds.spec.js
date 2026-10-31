// @ts-check
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const http = require('http');

const HMAC_KEY = '44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056';
const DEFAULTS = { outcome: 'received', notification: 'success', webhookUrl: null, webhookDelayMs: 1000 };

let counter = 0;
const unique = (prefix) => `${prefix}-${Date.now().toString(36)}-${counter++}`;

const refundSettings = (request, data) => request.post('/user-interaction/refund-settings', { data });

function refund(request, { psp = 'PAYMENTPSP000001', key = unique('key'), apiKey = 'test-key', data } = {}) {
  const headers = { 'Idempotency-Key': key };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return request.post(`/checkout/v71/payments/${psp}/refunds`, {
    headers,
    data: data || { merchantAccount: 'FloristITECOM', amount: { currency: 'NOK', value: 59900 }, reference: key },
  });
}

// Adyen's signing string, written out again here so the test does not trust the mock's.
function expectedSignature(item, key) {
  const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const fields = [item.pspReference, item.originalReference, item.merchantAccountCode, item.merchantReference,
    item.amount.value, item.amount.currency, item.eventCode, item.success];
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(fields.map(esc).join(':')).digest('base64');
}

/** A webhook receiver: collects the notifications posted to it and answers them as `answer` says. */
async function webhook(answer = { status: 200, body: '[accepted]' }, holdMs = 0) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(JSON.parse(body));
      setTimeout(() => {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notificationResponse: answer.body }));
      }, holdMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/api/v1/webhooks/adyen`,
    received,
    items: () => received.map((payload) => payload.notificationItems[0].NotificationRequestItem),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  await refundSettings(request, { ...DEFAULTS, hmacKey: null });
  await request.delete('/user-interaction/refunds');
});

test('Refund settings - read, changed, and the HMAC key never read back', async ({ request }) => {
  expect(await (await request.get('/user-interaction/refund-settings')).json()).toEqual({ ...DEFAULTS, hmacKeySet: false });

  const changed = await refundSettings(request, { outcome: 'lostAnswer', notification: 'refundFailed', webhookUrl: 'http://localhost:9/hook', webhookDelayMs: 0, hmacKey: HMAC_KEY });
  expect(changed.status()).toBe(200);
  const settings = await changed.json();
  expect(settings).toEqual({ outcome: 'lostAnswer', notification: 'refundFailed', webhookUrl: 'http://localhost:9/hook', webhookDelayMs: 0, hmacKeySet: true });
  expect(JSON.stringify(settings)).not.toContain(HMAC_KEY);
});

test('Refund settings - invalid values are refused and change nothing', async ({ request }) => {
  for (const data of [{ outcome: 'maybe' }, { notification: 'later' }, { webhookUrl: 'ftp://x' }, { webhookUrl: 'not a url' }, { webhookUrl: 'http://user:secret@localhost:8000/hook' }, { webhookUrl: 'http://user@localhost:8000/hook' }, { hmacKey: 'xyz' }, { hmacKey: 'abc' }, { webhookDelayMs: -1 }, { webhookDelayMs: 60001 }, { pin: '1234' }]) {
    const response = await refundSettings(request, data);
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toBeTruthy();
  }
  expect(await (await request.get('/user-interaction/refund-settings')).json()).toEqual({ ...DEFAULTS, hmacKeySet: false });
});

test('Refund - accepted as "received" with its own PSP reference', async ({ request }) => {
  const key = unique('return');
  const response = await refund(request, { psp: 'CWBC43ZX2VTFWR82', key });
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body).toEqual({
    merchantAccount: 'FloristITECOM',
    paymentPspReference: 'CWBC43ZX2VTFWR82',
    pspReference: expect.stringMatching(/^[A-Z0-9]{16}$/),
    reference: key,
    status: 'received',
    amount: { currency: 'NOK', value: 59900 },
  });
  expect(body.pspReference).not.toBe('CWBC43ZX2VTFWR82');

  const refunds = await (await request.get('/user-interaction/refunds')).json();
  expect(refunds).toHaveLength(1);
  expect(refunds[0].refund).toEqual(body);
});

test('Refund - no API key is 401, an invalid body 422, and neither refunds anything', async ({ request }) => {
  expect((await refund(request, { apiKey: null })).status()).toBe(401);
  for (const data of [
    { amount: { currency: 'NOK', value: 100 } },
    { merchantAccount: 'FloristITECOM' },
    { merchantAccount: 'FloristITECOM', amount: { currency: 'nok', value: 100 } },
    { merchantAccount: 'FloristITECOM', amount: { currency: 'NOK', value: 0 } },
    { merchantAccount: 'FloristITECOM', amount: { currency: 'NOK', value: 5.5 } },
  ]) {
    const response = await refund(request, { data });
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({ status: 422, errorType: 'validation' });
  }
  expect(await (await request.get('/user-interaction/refunds')).json()).toEqual([]);
});

test('Refund - the same Idempotency-Key refunds once and gets the same answer', async ({ request }) => {
  const key = unique('same');
  const first = await (await refund(request, { key })).json();
  const again = await refund(request, { key });
  expect(again.status()).toBe(201);
  expect(await again.json()).toEqual(first);
  expect(await (await request.get('/user-interaction/refunds')).json()).toHaveLength(1);
});

test('Refund - refused and server error refund nothing', async ({ request }) => {
  await refundSettings(request, { outcome: 'refused' });
  const refused = await refund(request);
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({ status: 422, errorType: 'validation' });

  await refundSettings(request, { outcome: 'serverError' });
  const failed = await refund(request);
  expect(failed.status()).toBe(500);
  expect(await failed.json()).toMatchObject({ status: 500, errorType: 'internal' });

  expect(await (await request.get('/user-interaction/refunds')).json()).toEqual([]);
});

test('Refund - a lost answer: made, answered 500, and a retry with its key gets the 201', async ({ request }) => {
  const key = unique('lost');
  await refundSettings(request, { outcome: 'lostAnswer' });
  const lost = await refund(request, { key });
  expect(lost.status()).toBe(500);
  const refunds = await (await request.get('/user-interaction/refunds')).json();
  expect(refunds).toHaveLength(1);

  await refundSettings(request, { outcome: 'received' });
  const retry = await refund(request, { key });
  expect(retry.status()).toBe(201);
  expect((await retry.json()).pspReference).toBe(refunds[0].refund.pspReference);
  expect(await (await request.get('/user-interaction/refunds')).json()).toHaveLength(1);
});

test('Notification - REFUND posted to the webhook, HMAC-signed, and its answer recorded', async ({ request }) => {
  const hook = await webhook();
  try {
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 100, hmacKey: HMAC_KEY });
    const key = unique('signed');
    const made = await (await refund(request, { psp: 'CWBC43ZX2VTFWR82', key })).json();

    await expect.poll(() => hook.received.length).toBe(1);
    expect(hook.received[0].live).toBe('false');
    const [item] = hook.items();
    expect(item).toMatchObject({
      eventCode: 'REFUND',
      success: 'true',
      pspReference: made.pspReference,
      originalReference: 'CWBC43ZX2VTFWR82',
      merchantReference: key,
      merchantAccountCode: 'FloristITECOM',
      amount: { currency: 'NOK', value: 59900 },
    });
    expect(item.additionalData.hmacSignature).toBe(expectedSignature(item, HMAC_KEY));

    await expect.poll(async () => (await (await request.get('/user-interaction/refunds')).json())[0].notifications[0]?.status).toBe(200);
  } finally {
    await hook.close();
  }
});

test('Notification - a failed refund, and a refund the card scheme rejects later', async ({ request }) => {
  const hook = await webhook();
  try {
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 0, hmacKey: HMAC_KEY, notification: 'failed' });
    await refund(request);
    await expect.poll(() => hook.received.length).toBe(1);
    expect(hook.items()[0]).toMatchObject({ eventCode: 'REFUND', success: 'false', reason: expect.any(String) });

    await refundSettings(request, { notification: 'refundFailed' });
    const made = await (await refund(request)).json();
    await expect.poll(() => hook.received.length).toBe(3);
    const [refunded, rejected] = hook.items().slice(1);
    expect(refunded).toMatchObject({ eventCode: 'REFUND', success: 'true', pspReference: made.pspReference });
    expect(rejected).toMatchObject({ eventCode: 'REFUND_FAILED', pspReference: made.pspReference });
    for (const item of hook.items()) {
      expect(item.additionalData.hmacSignature).toBe(expectedSignature(item, HMAC_KEY));
    }
  } finally {
    await hook.close();
  }
});

test('Notification - none sent with "none", and none for a refund that was not made', async ({ request }) => {
  const hook = await webhook();
  try {
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 0, notification: 'none' });
    expect((await refund(request)).status()).toBe(201);
    await refundSettings(request, { notification: 'success', outcome: 'refused' });
    expect((await refund(request)).status()).toBe(422);
    // Give a notification time to arrive, if one were sent.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(hook.received).toEqual([]);
  } finally {
    await hook.close();
  }
});

test('Notification - unsigned without an HMAC key; a webhook that fails is recorded', async ({ request }) => {
  const hook = await webhook({ status: 401, body: 'Invalid HMAC signature' });
  try {
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 0 });
    await refund(request);
    await expect.poll(() => hook.received.length).toBe(1);
    expect(hook.items()[0].additionalData).toEqual({});
    await expect.poll(async () => (await (await request.get('/user-interaction/refunds')).json())[0].notifications[0]?.status).toBe(401);
  } finally {
    await hook.close();
  }
});

test('Refund - a retry after more than 1000 later refunds still refunds nothing more', async ({ request }) => {
  const key = unique('early');
  const first = await (await refund(request, { key })).json();
  for (let i = 0; i < 1001; i++) {
    expect((await refund(request)).status()).toBe(201);
  }
  const retry = await refund(request, { key });
  expect(retry.status()).toBe(201);
  expect((await retry.json()).pspReference).toBe(first.pspReference);
  // The history keeps the latest 1000; the retry added none.
  const refunds = await (await request.get('/user-interaction/refunds')).json();
  expect(refunds).toHaveLength(1000);
  expect(refunds.some((r) => r.refund.reference === key)).toBe(false);
});

test('Notification - clearing the refunds stops a REFUND_FAILED still to come', async ({ request }) => {
  // The webhook holds its answer to the REFUND, so the clear lands between the two events.
  const hook = await webhook(undefined, 600);
  try {
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 0, notification: 'refundFailed' });
    await refund(request);
    await expect.poll(() => hook.received.length).toBe(1);
    await request.delete('/user-interaction/refunds');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(hook.items().map((item) => item.eventCode)).toEqual(['REFUND']);
  } finally {
    await hook.close();
  }
});

test('Notification - goes where it was meant to, signed with the key set when the refund was made', async ({ request }) => {
  const first = await webhook();
  const second = await webhook();
  const otherKey = 'AA'.repeat(32);
  try {
    await refundSettings(request, { webhookUrl: first.url, webhookDelayMs: 500, hmacKey: HMAC_KEY });
    await refund(request);
    await refundSettings(request, { webhookUrl: second.url, hmacKey: otherKey });
    await expect.poll(() => first.received.length).toBe(1);
    expect(first.items()[0].additionalData.hmacSignature).toBe(expectedSignature(first.items()[0], HMAC_KEY));
    expect(second.received).toEqual([]);
  } finally {
    await first.close();
    await second.close();
  }
});

test('Messages - a refund and its notification are in the message list', async ({ request }) => {
  const hook = await webhook();
  try {
    await request.post('/user-interaction/clear-codeblocks-button');
    await refundSettings(request, { webhookUrl: hook.url, webhookDelayMs: 0 });
    const made = await (await refund(request, { psp: 'CWBC43ZX2VTFWR82' })).json();
    await expect.poll(async () => (await (await request.get('/user-interaction/messages')).json()).messages.length).toBe(2);
    const [notification, refunded] = (await (await request.get('/user-interaction/messages')).json()).messages;
    expect(refunded).toMatchObject({ kind: 'refund', done: true, request: { refund: { paymentPspReference: 'CWBC43ZX2VTFWR82' } }, response: { status: 201, body: made } });
    await expect.poll(async () => (await (await request.get('/user-interaction/messages')).json()).messages[0].done).toBe(true);
    expect(notification).toMatchObject({ kind: 'notification', request: { webhookUrl: hook.url } });
  } finally {
    await hook.close();
  }
});

test('Page - the device panel changes the refund settings and lists a refund', async ({ page, request }) => {
  const hook = await webhook();
  try {
    await page.goto('/');
    await page.locator('#refund-outcome').selectOption('lostAnswer');
    await expect.poll(async () => (await (await request.get('/user-interaction/refund-settings')).json()).outcome).toBe('lostAnswer');
    await page.locator('#refund-notification').selectOption('refundFailed');
    await page.locator('#refund-webhook-url').fill(hook.url);
    await page.locator('#refund-webhook-url').press('Tab');
    await expect.poll(async () => (await (await request.get('/user-interaction/refund-settings')).json())).toMatchObject({ notification: 'refundFailed', webhookUrl: hook.url });
    await expect(page.locator('#checkout-url')).toHaveText(/\/checkout\/v71$/);

    await refundSettings(request, { outcome: 'received', notification: 'none' });
    await refund(request, { psp: 'CWBC43ZX2VTFWR82' });
    await expect(page.locator('.message', { hasText: 'Refund' }).first()).toContainText('201 · received');

    // Amounts by Adyen's currency table: 100 minor units of ISK (2 decimals at Adyen) are ISK 1.
    await refund(request, { psp: 'ISKPAYMENT000001', data: { merchantAccount: 'FloristITECOM', amount: { currency: 'ISK', value: 100 } } });
    const isk = page.locator('.message', { hasText: 'ISKPAYMENT000001' }).first();
    await expect(isk.locator('.message-detail')).toHaveText(/^(ISK\s?1|1\s?ISK) of ISKPAYMENT000001$/);
  } finally {
    await hook.close();
  }
});
