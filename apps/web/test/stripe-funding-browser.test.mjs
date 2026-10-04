// Explicit browser fixtures only. No Stripe checkout or blockchain requests.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({channel:process.env.BROWSER_CHANNEL ?? 'chrome',headless:true});
after(()=>browser.close());
const origin=process.env.WEB_TEST_URL ?? 'http://localhost:3017';
const user={email:'stripe@example.test',name:'Stripe',wallet:'fixture-wallet'};
const config={provider:'stripe',environment:'test',configured:true,usdPerCad:'0.73',minAmountCad:5,maxAmountCad:200,mintEnabled:true};
const record={id:'stripe-fixture',provider:'stripe',status:'checkout_ready',amountCad:'25.00',usdcAmount:'18.250000',wallet:user.wallet,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
async function setup(t,{checkout,status,cfg=config,path='/funding'}={}){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.addInitScript(user=>{if(!localStorage.getItem('solpouch.session'))localStorage.setItem('solpouch.session',JSON.stringify({token:'stripe-fixture',user}));},user);
 await page.route('**/auth/me',r=>r.fulfill({json:{user}}));
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/funding/config',r=>r.fulfill({json:cfg}));
 await page.route('**/funding/stripe',r=>r.fulfill({json:[]}));
 await page.route('**/funding/stripe/*',r=>r.request().url().endsWith('/checkout')?checkout?.(r):status?status(r):r.fulfill({json:record}));
 await page.goto(origin+path);return page;
}
test('Stripe quote, quick picks and invalid amount gate',async t=>{
 let calls=0;const page=await setup(t,{checkout:()=>{calls++;}});
 await page.getByText('You’ll get 18.250000 devnet test-USDC.').waitFor();
 await page.getByRole('button',{name:'$10',exact:true}).click();
 await page.getByText('You’ll get 7.300000 devnet test-USDC.').waitFor();
 await page.getByLabel('Amount · CAD',{exact:true}).fill('201');
 assert.equal(await page.getByRole('button',{name:'Continue to card checkout'}).isDisabled(),true);assert.equal(calls,0);
});
test('checkout lost response persists one idempotency key through reload and rejects hostile URL',async t=>{
 const bodies=[];const page=await setup(t,{checkout:r=>{bodies.push(r.request().postDataJSON());return bodies.length===1?r.abort():r.fulfill({json:{request:record,url:'https://checkout.stripe.com.evil.test/pay'}});}});
 await page.getByRole('button',{name:'Continue to card checkout'}).click();
 await page.getByRole('button',{name:'Retry the same checkout'}).waitFor();await page.reload();
 await page.getByRole('button',{name:'Retry the same checkout'}).click();
 await page.getByText('Invalid checkout destination. Check this request before trying again.').waitFor();
 assert.equal(bodies.length,2);assert.equal(bodies[0].idempotencyKey,bodies[1].idempotencyKey);assert.equal(new URL(page.url()).origin,origin);
});
test('return session is reconciled then confirmed only with a valid devnet transaction',async t=>{
 let calls=0;const page=await setup(t,{path:'/funding?session_id=cs_test_fixture',status:r=>{calls++;return r.fulfill({json:{...record,status:calls===1?'paid':'confirmed',txSignature:calls===1?undefined:'5'.repeat(88)}});}});
 await page.getByText('The wallet transfer is still being checked. No confirmed deposit yet.').waitFor();
 await page.getByText('Payment received, 18.250000 devnet test-USDC added',{exact:true}).waitFor();
 assert.equal(await page.getByRole('link',{name:'View mint transaction ↗'}).getAttribute('href'),`https://explorer.solana.com/tx/${'5'.repeat(88)}?cluster=devnet`);
 await page.getByRole('link',{name:'Top up a pouch'}).waitFor();
});
test('paid without mint never reports wallet credit',async t=>{
 const page=await setup(t,{cfg:{...config,mintEnabled:false},path:'/funding?session_id=cs_test_fixture',status:r=>r.fulfill({json:{...record,status:'paid'}})});
 await page.getByText('Wallet crediting is disabled. No funds were added.').waitFor();assert.equal(await page.getByRole('link',{name:'View mint transaction ↗'}).count(),0);
});
test('polling stops after two minutes and can be retried',async t=>{
 const page=await setup(t);await page.clock.install();await page.goto(origin+'/funding?session_id=cs_test_fixture');
 await page.getByText('Checking payment status…').waitFor();await page.clock.fastForward(121000);
 await page.getByText('Status checks paused after two minutes. Your request is saved. Check again before making another payment.').waitFor();
 await page.getByRole('button',{name:'Check status',exact:true}).click();await page.getByText('Checking payment status…').waitFor();
});
test('late checkout response cannot navigate after account changes',async t=>{
 let release,arrive;const held=new Promise(r=>release=r), arrived=new Promise(r=>arrive=r);
 const page=await setup(t,{checkout:async r=>{arrive();await held;await r.fulfill({json:{request:record,url:'https://checkout.stripe.com/c/pay/cs_test_fixture'}}).catch(()=>{});}});
 await page.getByRole('button',{name:'Continue to card checkout'}).click();await arrived;
 await page.evaluate(()=>{const key='solpouch.session',oldValue=localStorage.getItem(key),newValue=JSON.stringify({token:'other',user:{email:'other@example.test',wallet:'other-wallet',name:'Other'}});localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue,storageArea:localStorage}));});
 release();await page.waitForTimeout(250);assert.equal(new URL(page.url()).origin,origin);
});
test('verified expired checkout permits a deliberate new request',async t=>{
 const bodies=[];let status='expired';const page=await setup(t,{path:'/funding?session_id=cs_test_fixture',status:r=>r.fulfill({json:{...record,status}}),checkout:r=>{bodies.push(r.request().postDataJSON());status='paid';return r.fulfill({json:{request:{...record,status:'paid'}}});},cfg:{...config,mintEnabled:false}});
 await page.getByText('Checkout expired. No payment was received.').waitFor();await page.getByRole('button',{name:'Start another request'}).click();
 assert.equal(new URL(page.url()).search,'');await page.getByRole('button',{name:'Continue to card checkout'}).click();await page.getByText('Wallet crediting is disabled. No funds were added.').waitFor();assert.equal(bodies.length,1);
});
