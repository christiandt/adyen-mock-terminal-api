// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const payloads = path.join(__dirname, '../../public/payloads');
const load = (file) => JSON.parse(fs.readFileSync(path.join(payloads, file), 'utf-8'));

let counter = 0;
function paymentRequest(amount) {
  const body = load('payment/paymentRequest.json');
  body.SaleToPOIRequest.MessageHeader.ServiceID = `c${Date.now().toString(36)}${counter++}`.slice(-10);
  body.SaleToPOIRequest.PaymentRequest.PaymentTransaction.AmountsReq = { Currency: 'NOK', RequestedAmount: amount };
  return body;
}

const settings = (request, data) => request.post('/user-interaction/settings', { data });

async function pay(request, amount = 500) {
  const response = await (await request.post('/sync', { data: paymentRequest(amount) })).json();
  const payment = response.SaleToPOIResponse.PaymentResponse;
  return { payment, card: payment.PaymentResult.PaymentInstrumentData?.CardData, additional: new URLSearchParams(payment.Response.AdditionalResponse) };
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await settings(request, { autoConfirm: true, autoConfirmDelayMs: 0 });
});

test.afterEach(async ({ request }) => {
  await settings(request, { autoConfirm: false, autoConfirmDelayMs: 1000, card: 'visa', cardLast4: null });
});

test('Cards - the presets are listed', async ({ request }) => {
  const cards = await (await request.get('/user-interaction/cards')).json();
  expect(cards.map((card) => card.id)).toEqual(['visa', 'visadebit', 'mc', 'mcdebit', 'maestro', 'amex', 'vpay', 'bankaxept']);
  expect(cards.every((card) => typeof card.label === 'string' && card.label.length > 0)).toBe(true);
});

test('Cards - by default an approval is on the Visa test card', async ({ request }) => {
  const { card, additional } = await pay(request);
  expect(card).toMatchObject({ PaymentBrand: 'visa', MaskedPan: '411111 **** 1111' });
  expect(additional.get('paymentMethod')).toBe('visa');
  expect(additional.get('paymentMethodVariant')).toBe('visacredit');
  expect(additional.get('fundingSource')).toBe('CREDIT');
});

for (const [id, brand, variant, funding] of [
  ['visadebit', 'visa', 'visadebit', 'DEBIT'],
  ['mc', 'mc', 'mc', 'CREDIT'],
  ['mcdebit', 'mc', 'mcdebit', 'DEBIT'],
  ['maestro', 'maestro', 'maestro', 'DEBIT'],
  ['amex', 'amex', 'amex', 'CREDIT'],
  ['vpay', 'vpay', 'vpay', 'DEBIT'],
  ['bankaxept', 'bankaxept', 'bankaxept', 'DEBIT'],
]) {
  test(`Cards - ${id} uses Adyen's identifiers`, async ({ request }) => {
    expect((await settings(request, { card: id })).status()).toBe(200);
    const { card, additional } = await pay(request);
    expect(card.PaymentBrand).toBe(brand);
    expect(additional.get('paymentMethod')).toBe(brand);
    expect(additional.get('paymentMethodVariant')).toBe(variant);
    expect(additional.get('fundingSource')).toBe(funding);
    expect(card.MaskedPan).toBe(`${additional.get('cardBin')} **** ${additional.get('cardSummary')}`);
  });
}

test('Cards - cardLast4 replaces the last four digits; null restores them', async ({ request }) => {
  await settings(request, { card: 'mc', cardLast4: '4242' });
  let { card, additional } = await pay(request);
  expect(additional.get('cardSummary')).toBe('4242');
  expect(card.MaskedPan).toBe('555544 **** 4242');

  await settings(request, { cardLast4: null });
  ({ card, additional } = await pay(request));
  expect(additional.get('cardSummary')).toBe('4444');
});

test('Cards - a refused payment shows the card that was refused', async ({ request }) => {
  await settings(request, { card: 'amex' });
  const { payment, card } = await pay(request, 1.25);
  expect(payment.Response.ErrorCondition).toBe('Refusal');
  expect(card).toMatchObject({ PaymentBrand: 'amex', MaskedPan: '370000 **** 0002' });
  expect(new URLSearchParams(payment.Response.AdditionalResponse).get('refusalReason')).toBe('199 Card blocked');
});

test('Cards - the menu on the page changes the card', async ({ page, request }) => {
  await settings(request, { autoConfirm: false });
  await page.goto('/');
  const menu = page.locator('#card-select');
  await expect(menu).toHaveValue('visa');
  await menu.selectOption('bankaxept');
  await expect.poll(async () => (await (await request.get('/user-interaction/settings')).json()).card).toBe('bankaxept');
});
