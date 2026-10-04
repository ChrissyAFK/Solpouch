// Run against WEB_TEST_URL with Playwright available (or PLAYWRIGHT_MODULE set).
// Backend responses are fixtures; no payment or external checkout is performed.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3004';
const session = { token: 'fixture', user: { email: 'review@example.test', name: 'Reviewer' } };
const pouch = { id: 'fixture', name: 'Shopping', balance: 500000000, spentToday: 0, dailyLimit: 500000000, maxPerOrder: 500000000, confirmAbove: 0, allowedMerchantIds: [], frozen: false };
const base = { id: 'reference', pouchId: pouch.id, merchantId: 'web:retailer.example', request: 'chainsaw', lines: [], total: 299990000, createdAt: '2026-10-03T12:00:00Z', store: { name: 'Retailer', domain: 'retailer.example', url: 'https://retailer.example' }, fulfillment: { via: 'service', label: 'Solpouch Buyer', checkoutUrl: 'https://retailer.example' } };
for (const status of ['draft', 'paid']) {
  test(`web ${status} shows checkout truth without offering a payment`, async t => {
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.addInitScript(session => localStorage.setItem('solpouch.session', JSON.stringify(session)), session);
    await page.route('**/auth/me', route => route.fulfill({ json: { user: session.user } }));
    await page.route('**/orders/reference', route => route.fulfill({ json: { ...base, status, ...(status === 'paid' ? { txSignature: 'mock-fixture' } : {}) } }));
    await page.route('**/pouches', route => route.fulfill({ json: [pouch] }));
    await page.route('**/merchants', route => route.fulfill({ json: [] }));
    await page.goto(`${origin}/order?order=reference`);
    await page.getByRole('link', { name: 'Open store page', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open store page', exact: true }).getAttribute('href'), base.store.url);
    assert.equal(await page.getByText(/Bought via/).count(), 0);
    if (status === 'draft') {
      assert.equal(await page.getByRole('button', { name: 'Complete checkout with the retailer', exact: true }).isDisabled(), true);
      await page.getByText('Estimated total · CAD', { exact: true }).waitFor();
      await page.getByText(/Solpouch has not placed an order/).waitFor();
    } else {
      await page.getByText(/no retailer purchase or fulfillment has been confirmed/).waitFor();
    }
  });
}
test('order page separates demo preparation from payment and labels receipt',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 let state={...base,status:'draft',version:2};let payments=0;
 await page.addInitScript(session=>localStorage.setItem('solpouch.session',JSON.stringify(session)),session);
 await page.route('**/auth/me',r=>r.fulfill({json:{user:session.user}}));
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/pouches',r=>r.fulfill({json:[pouch]}));await page.route('**/merchants',r=>r.fulfill({json:[]}));
 await page.route('**/orders/reference',r=>r.fulfill({json:state}));
 await page.route('**/orders/reference/demo-checkout',r=>{assert.equal(r.request().postDataJSON().version,2);state={...state,version:3,total:218992700,fulfillment:{via:'demo',label:'Devnet demo checkout',demo:{sourceCurrency:'CAD',sourceTotal:299990000,sourceLines:[],usdPerCad:'0.73',payTo:'FixtureCheckoutWallet',preparedAt:new Date().toISOString()}}};return r.fulfill({json:state});});
 await page.route('**/orders/reference/confirm',r=>{payments++;assert.equal(r.request().postDataJSON().version,3);state={...state,status:'paid',txSignature:'5'.repeat(88)};return r.fulfill({json:state});});
 await page.goto(origin+'/order?order=reference');await page.getByRole('button',{name:'Prepare checkout'}).click();
 await page.getByText('Source estimate',{exact:false}).first().waitFor();assert.equal(payments,0);
 await page.getByRole('button',{name:'Pay checkout · 218.99 USDC'}).click();await page.locator('[aria-label="Receipt"]').waitFor();
 assert.equal(payments,1);await page.getByText('Source estimate',{exact:false}).first().waitFor();
});
