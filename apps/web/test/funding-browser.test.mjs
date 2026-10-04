// Intercepted provider and backend fixtures; no real bank or blockchain traffic.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3003';
const user = { email: 'funding@example.test', name: 'Funding', wallet: 'fixture-wallet' };
const config = { environment:'staging',productionEnabled:false,configured:true,countries:[{country:'US',currency:'USD',buyEnabled:true,sellEnabled:true},{country:'CA',currency:'CAD',buyEnabled:true,sellEnabled:false}],notice:'Sandbox fixtures only.' };
const request = {id:'fundfixture',direction:'BUY',country:'US',currency:'USD',amount:'25.00',wallet:user.wallet,environment:'staging',status:'session_ready',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
async function setup(t, handle, cfg=config) {
 const page=await browser.newPage();t.after(()=>page.close());
 await page.addInitScript(user=>{if(!localStorage.getItem('solpouch.session'))localStorage.setItem('solpouch.session',JSON.stringify({token:'funding-fixture',user}));},user);
 await page.route('**/auth/me',r=>r.fulfill({json:{user}}));
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/funding/config',r=>r.fulfill({json:cfg}));
 await page.route(/\/funding$/,r=>r.request().resourceType()==='document'?r.fallback():r.request().method()==='POST'?handle(r):r.fulfill({json:[]}));
 await page.goto(`${origin}/funding`);
 return page;
}
test('country eligibility and withdrawals have clear disabled states',async t=>{
 const page=await setup(t,()=>{throw new Error('No request expected');});
 await page.getByLabel('Country',{exact:true}).selectOption('CA');
 await page.getByLabel('Amount · CAD',{exact:true}).fill('25');
 await page.getByLabel('Action',{exact:true}).selectOption('SELL');
 await page.getByText('Cashing out in Canada is not configured yet.').waitFor();
 assert.equal(await page.getByRole('button',{name:'Continue to test checkout'}).isDisabled(),true);
 await page.getByLabel('Amount · USDC',{exact:true}).waitFor();
});
test('lost response retry after reload reuses the same request UUID',async t=>{
 const bodies=[];
 const page=await setup(t,r=>{bodies.push(r.request().postDataJSON());return bodies.length===1?r.abort():r.fulfill({json:{request,widgetUrl:'https://global-stg.transak.com/?sessionId=fixture'}});});
 await page.getByLabel('Amount · USD',{exact:true}).fill('25');
 await page.getByRole('button',{name:'Continue to test checkout'}).click();
 await page.getByRole('button',{name:'Retry the same request'}).waitFor();
 await page.reload();
 await page.getByRole('button',{name:'Retry the same request'}).click();
 await page.getByRole('link',{name:'Open test checkout ↗'}).waitFor();
 assert.equal(bodies.length,2);assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);
 assert.equal(await page.getByLabel('Country',{exact:true}).isDisabled(),true);
});
test('provider sandbox completion never claims a real balance deposit',async t=>{
 const page=await setup(t,r=>r.fulfill({json:{request,widgetUrl:'https://global-stg.transak.com/?sessionId=fixture'}}));
 await page.route('**/funding/fundfixture/reconcile',r=>r.fulfill({json:{...request,status:'sandbox_completed'}}));
 await page.getByLabel('Amount · USD',{exact:true}).fill('25');
 await page.getByRole('button',{name:'Continue to test checkout'}).click();
 await page.getByRole('button',{name:'Check status',exact:true}).click();
 await page.getByText('Test completed · no real funds',{exact:true}).waitFor();
});
test('hosted checkout rejects an untrusted destination',async t=>{
 const page=await setup(t,r=>r.fulfill({json:{request,widgetUrl:'https://example.org/?sessionId=fixture'}}));
 await page.getByLabel('Amount · USD',{exact:true}).fill('25');
 await page.getByRole('button',{name:'Continue to test checkout'}).click();
 await page.getByRole('button',{name:'Retry the same request'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Open test checkout ↗'}).count(),0);
});
test('missing funding storage keeps setup and wallet options visible',async t=>{
 const page=await setup(t,r=>r.fulfill({json:[]}),{...config,configured:false});
 await page.route(/\/funding$/,r=>r.request().resourceType()==='document'?r.fallback():r.fulfill({status:503,json:{error:'Funding storage not configured'}}));
 await page.reload();
 await page.getByRole('heading',{name:'Linked wallet',exact:true}).waitFor();
 await page.getByText('Adding money in the United States is not configured yet.').waitFor();
 assert.equal(await page.getByLabel('Country',{exact:true}).count(),1);
});
test('terminal funding enables a deliberate new request with a fresh UUID',async t=>{
 const bodies=[];
 const page=await setup(t,r=>{bodies.push(r.request().postDataJSON());return r.fulfill({json:{request:{...request,status:'sandbox_completed'}}});});
 await page.getByLabel('Amount · USD',{exact:true}).fill('25');
 await page.getByRole('button',{name:'Continue to test checkout'}).click();
 await page.getByRole('button',{name:'Start another request'}).click();
 await page.getByRole('button',{name:'Continue to test checkout'}).click();
 await page.getByRole('button',{name:'Start another request'}).waitFor();
 assert.equal(bodies.length,2);assert.notEqual(bodies[0].idempotencyKey,bodies[1].idempotencyKey);
});
test('late funding response cannot expose checkout to a different account',async t=>{
 let release,arrive;const held=new Promise(r=>release=r);const arrived=new Promise(r=>arrive=r);
 const page=await setup(t,async r=>{arrive();await held;await r.fulfill({json:{request,widgetUrl:'https://global-stg.transak.com/?sessionId=private-fixture'}}).catch(()=>{});});
 await page.getByLabel('Amount · USD',{exact:true}).fill('25');
 await page.getByRole('button',{name:'Continue to test checkout'}).click();await arrived;
 await page.evaluate(()=>{const key='solpouch.session';const oldValue=localStorage.getItem(key);const newValue=JSON.stringify({token:'new-account',user:{email:'other@example.test',name:'Other',wallet:'another-wallet'}});localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue,storageArea:localStorage}));});
 release();await page.getByRole('link',{name:'Profile',exact:true}).filter({hasText:'Other'}).waitFor();await page.waitForTimeout(200);
 assert.equal(await page.getByRole('link',{name:'Open test checkout ↗'}).count(),0);
 assert.equal(await page.getByText('Add money · 25.00 USD',{exact:true}).count(),0);
});
