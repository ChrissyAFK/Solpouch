// Real browser UI with local API fixtures. No Google, payment or delivery calls.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3005';
// Alice has a linked wallet (top-ups require one); Bob does not.
const a = { token: 'fixture-a', user: { email: 'alice@example.test', name: 'Alice', wallet: '11111111111111111111111111111112' } };
const b = { token: 'fixture-b', user: { email: 'bob@example.test', name: 'Bob' } };
const pouch = { id: 'p', name: 'Shopping', balance: 10000000, spentToday: 0, dailyLimit: 100000000, maxPerOrder: 50000000, allowedMerchantIds: [], frozen: false };
const profile = user => ({ wallet: null, ...user, picture: '', displayName: null, avatar: null, googleName: user.name, googlePicture: '', createdAt: '2026-01-01T00:00:00Z' });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
async function setup(t, handler = async () => false) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.addInitScript(a => localStorage.setItem('solpouch.session', JSON.stringify(a)), a);
  await page.route('http://localhost:8787/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const user = route.request().headers().authorization === 'Bearer fixture-b' ? b.user : a.user;
    if (await handler(route, path, user)) return;
    const json = path === '/auth/me' ? { user } : path === '/profile' ? profile(user) : path === '/pouches' ? [pouch] : path === '/auth/sessions' ? { sessions: [{ id: 'current', current: true, createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }] } : path === '/auth/logout' || path === '/auth/logout-all' ? { ok: true } : [];
    await route.fulfill({ json });
  });
  return page;
}
async function switchAccount(page, session) {
  await page.evaluate(session => {
    localStorage.setItem('solpouch.session', JSON.stringify(session));
    window.dispatchEvent(new StorageEvent('storage', { key: 'solpouch.session' }));
  }, session);
  await page.getByRole('link', { name: 'Profile', exact: true }).filter({ hasText: session.user.name }).waitFor();
}
test('account replacement resets profile and old pending save cannot modify the new identity', async t => {
  const held = deferred(); const saving = deferred();
  const page = await setup(t, async (route, path) => {
    if (path !== '/profile' || route.request().method() !== 'PATCH') return false;
    saving.resolve(); await held.promise;
    await route.fulfill({ json: { ...profile(a.user), name: 'Alice edited', displayName: 'Alice edited' } }); return true;
  });
  await page.goto(`${origin}/profile`);
  await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice edited');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await saving.promise;
  await switchAccount(page, b);
  await page.waitForFunction(() => document.querySelector('#email')?.value === 'bob@example.test');
  held.resolve(); await page.waitForTimeout(200);
  assert.equal(await page.getByRole('textbox', { name: 'Display name', exact: true }).inputValue(), 'Bob');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('solpouch.session')).user.name), 'Bob');
});
test('latest refresh wins even when an older pouch request finishes afterwards', async t => {
  const held = deferred(); const arrived = deferred(); let count = 0; let armed = false;
  const page = await setup(t, async (route, path) => {
    if (path !== '/pouches') return false;
    const n = armed ? ++count : 0; if (n === 1) { arrived.resolve(); await held.promise; }
    await route.fulfill({ json: [{ ...pouch, frozen: n >= 2 }] }); return true;
  });
  await page.goto(`${origin}/pouches`); await page.getByRole('button', { name: 'Freeze Shopping', exact: true }).waitFor();
  armed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await arrived.promise;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.getByRole('button', { name: 'Unfreeze Shopping', exact: true }).waitFor();
  held.resolve(); await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: 'Freeze Shopping', exact: true }).count(), 0);
});
test('session controls revoke selected sessions and sign out everywhere with the current bearer', async t => {
  const calls = []; let revoked = false;
  const page = await setup(t, async (route, path) => {
    if (path === '/auth/sessions') { await route.fulfill({ json: { sessions: revoked ? [] : [{ id: 'other', current: false, createdAt: '2026-01-01', expiresAt: '2027-01-01' }] } }); return true; }
    if (path === '/auth/sessions/other' || path === '/auth/logout-all') { calls.push([path, route.request().method(), route.request().headers().authorization]); revoked = true; await route.fulfill({ json: { ok: true } }); return true; }
    return false;
  });
  await page.goto(`${origin}/profile`); await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByRole('button', { name: 'End session', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('solpouch.session') === null);
  assert.deepEqual(calls, [['/auth/sessions/other', 'DELETE', 'Bearer fixture-a'], ['/auth/logout-all', 'POST', 'Bearer fixture-a']]);
});
test('failed server logout clears local identity and explains incomplete revocation', async t => {
  const page = await setup(t, async (route, path) => { if (path !== '/auth/logout') return false; await route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }); return true; });
  await page.goto(`${origin}/dashboard`); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText(/could not revoke the server session/).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('solpouch.session')), null);
});
test('order filters combine and exported CSV neutralizes formula names', async t => {
  const orders = [
    { id: 'one', pouchId: 'p', merchantId: 'shop', request: 'milk', status: 'paid', lines: [], total: 12000000, createdAt: '2026-10-01T12:00:00Z', paidAt: '2026-10-02T12:00:00Z', store: { name: '=HYPERLINK("evil")', domain: 'shop.example' } },
    { id: 'two', pouchId: 'q', merchantId: 'other', request: 'bread', status: 'draft', lines: [], total: 3000000, createdAt: '2026-09-01T12:00:00Z' },
  ];
  const page = await setup(t, async (route, path) => { if (path !== '/orders') return false; await route.fulfill({ json: orders }); return true; });
  await page.goto(`${origin}/orders`); await page.getByText('2 of 2 orders').waitFor();
  const filters = page.getByRole('region', { name: 'Filter order history' });
  await filters.getByLabel('Pouch', { exact: true }).selectOption('p');
  await filters.getByLabel('Status', { exact: true }).selectOption('paid');
  await filters.getByLabel('Store', { exact: true }).selectOption('shop');
  await filters.getByLabel('From date', { exact: true }).fill('2026-10-01');
  await filters.getByLabel('To date', { exact: true }).fill('2026-10-03');
  await page.getByText('1 of 2 orders').waitFor();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export filtered CSV' }).click();
  const stream = await (await downloaded).createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString();
  assert.ok(csv.includes("'=")); assert.ok(csv.includes('2026-10-02')); assert.ok(csv.includes('one')); assert.ok(!csv.includes('"two"'));
});
test('uncertain payment recovers same order and receipt uses paid time', async t => {
  const order = { id: 'pending', pouchId: 'p', merchantId: 'shop', request: 'milk', status: 'paying', lines: [], total: 12000000, createdAt: '2026-09-01T12:00:00Z' }; let confirms = 0;
  const page = await setup(t, async (route, path) => {
    if (path === '/orders/pending') { await route.fulfill({ json: order }); return true; }
    if (path === '/orders/pending/confirm') { confirms++; await route.fulfill({ json: { ...order, status: 'paid', paidAt: '2026-10-02T12:00:00Z', txSignature: 'mock-fixture' } }); return true; }
    return false;
  });
  await page.goto(`${origin}/order?order=pending`); await page.getByRole('button', { name: 'Check payment status', exact: true }).click();
  await page.getByLabel('Receipt', { exact: true }).waitFor();
  assert.equal(confirms, 1); assert.match(await page.getByLabel('Receipt', { exact: true }).innerText(), /Paid Oct 2, 2026/);
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download receipt' }).click();
  const stream = await (await downloaded).createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /Paid: 2026-10-02/);
});
test('alerts require opt-in, are deduplicated and do not follow another account', async t => {
  let topupRequests = 0; let topupReady = true;
  const page = await setup(t, async (route, path) => {
    if (path === '/pouches') { await route.fulfill({ json: [{ ...pouch, spentToday: 85000000 }] }); return true; }
    if (path === '/topups') { topupRequests++; await route.fulfill({ json: topupReady ? [{ id: 'ready', pouchId: 'p', status: 'cooling_down', readyAt: '2026-01-01T00:00:00Z' }] : [] }); return true; }
    return false;
  });
  await page.goto(`${origin}/profile`); await page.getByRole('checkbox').waitFor(); assert.equal(topupRequests, 0);
  await page.getByRole('checkbox').check();
  await page.getByRole('link', { name: /80% of today's limit/ }).waitFor();
  await page.getByRole('link', { name: /top-up for Shopping is ready/ }).waitFor();
  await page.getByRole('button', { name: /Dismiss: Shopping/ }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(200);
  assert.equal(await page.getByRole('link', { name: /80% of today's limit/ }).count(), 0);
  topupReady = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('link', { name: /top-up for Shopping is ready/ }).waitFor({ state: 'detached' });
  await page.reload(); await page.getByRole('checkbox').waitFor();
  assert.equal(await page.getByRole('checkbox').isChecked(), true);
  assert.equal(await page.getByRole('link', { name: /80% of today's limit/ }).count(), 0);
  await switchAccount(page, b);
  assert.equal(await page.getByRole('complementary', { name: 'Spending alerts', exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
});
test('information navigation links lead to landing-page sections', async t => {
  const page = await setup(t); await page.goto(`${origin}/about`);
  assert.equal(await page.getByRole('link', { name: 'How it works', exact: true }).getAttribute('href'), '/#how-it-works');
  assert.equal(await page.getByRole('link', { name: 'Questions', exact: true }).getAttribute('href'), '/#questions');
});
test('Instacart link creation keeps catalog currency and never charges the pouch', async t => {
  const order = { id: 'grocery', pouchId: 'p', merchantId: 'shop', request: 'milk', status: 'draft', lines: [], total: 12000000, createdAt: '2026-09-01T12:00:00Z' }; let calls = 0; let paid = false;
  const page = await setup(t, async (route, path) => {
    if (path === '/orders/grocery') { await route.fulfill({ json: order }); return true; }
    if (path === '/orders/grocery/confirm') { paid = true; await route.fulfill({ json: order }); return true; }
    if (path === '/orders/grocery/instacart') { calls++; await route.fulfill({ json: { ...order, fulfillment: { via: 'instacart', label: 'Instacart shopping list', checkoutUrl: 'https://www.instacart.com/store/products/fixture', linkStatus: 'ready' } } }); return true; }
    return false;
  });
  await page.goto(`${origin}/order?order=grocery`);
  await page.getByRole('button', { name: 'Create Instacart shopping list', exact: true }).click();
  await page.getByRole('link', { name: 'Open Instacart cart', exact: true }).waitFor();
  await page.getByText('Estimated total · USDC', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Complete checkout with the retailer', exact: true }).isDisabled(), true);
  assert.equal(calls, 1); assert.equal(paid, false);
});
test('unconfigured Instacart explains the failure without claiming a purchase', async t => {
  const order = { id: 'grocery', pouchId: 'p', merchantId: 'shop', request: 'milk', status: 'draft', lines: [], total: 12000000, createdAt: '2026-09-01T12:00:00Z' };
  const page = await setup(t, async (route, path) => {
    if (path === '/orders/grocery') { await route.fulfill({ json: order }); return true; }
    if (path === '/orders/grocery/instacart') { await route.fulfill({ status: 503, json: { error: 'not configured', code: 'InstacartNotConfigured' } }); return true; }
    return false;
  });
  await page.goto(`${origin}/order?order=grocery`); await page.getByRole('button', { name: 'Create Instacart shopping list', exact: true }).click();
  await page.getByText('Instacart shopping links are not configured yet. No purchase was made.', { exact: true }).waitFor();
});
test('processing top-up checks the existing transfer and cannot be cancelled', async t => {
  let completed = false; let confirms = 0;
  const page = await setup(t, async (route, path) => {
    if (path === '/pouches/p') { await route.fulfill({ json: pouch }); return true; }
    if (path === '/topups') { await route.fulfill({ json: completed ? [] : [{ id: 'processing', pouchId: 'p', status: 'processing', amount: 1000000, readyAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }] }); return true; }
    if (path === '/topups/processing/complete') { completed = true; confirms++; await route.fulfill({ json: { id: 'processing', status: 'completed' } }); return true; }
    return false;
  });
  await page.goto(`${origin}/pouches/p`);
  await page.getByRole('button', { name: 'Check top-up status', exact: true }).waitFor();
  assert.equal(confirms, 0); assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Check top-up status', exact: true }).click();
  await page.getByText('Added $1.00 USDC to Shopping', { exact: true }).waitFor();
  assert.equal(confirms, 1);
});
test('another account can sign out while the first server revocation is still pending', async t => {
  const held = deferred(); const arrived = deferred(); const calls = [];
  const page = await setup(t, async (route, path) => {
    if (path !== '/auth/logout') return false;
    const token = route.request().headers().authorization; calls.push(token);
    if (token === 'Bearer fixture-a') { arrived.resolve(); await held.promise; }
    await route.fulfill({ json: { ok: true } }).catch(() => {}); return true;
  });
  await page.goto(`${origin}/dashboard`); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await arrived.promise;
  assert.equal(await page.evaluate(() => localStorage.getItem('solpouch.session')), null);
  await switchAccount(page, b); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('solpouch.session') === null);
  held.resolve(); await page.waitForTimeout(100);
  assert.deepEqual(calls, ['Bearer fixture-a', 'Bearer fixture-b']);
});
