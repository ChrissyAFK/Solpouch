// Account-backed cart cards: intercepted APIs, no real purchases.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3003';
const user = { email: 'cards@example.test', name: 'Cards' };
const draft = { id: 'cartfixture', pouchId: 'groceries', merchantId: 'market', status: 'draft', total: 5000000, request:'eggs',createdAt:'2026-10-03T12:00:00Z',lines:[{requested:'eggs',requestedQty:1,qty:1,lineTotal:5000000,matchScore:1,substitution:false,product:{id:'eggs',merchantId:'market',name:'Eggs',unitPrice:5000000,inStock:true}}] };
async function setup(t, orders, before = async () => {}) {
 const page=await browser.newPage();t.after(()=>page.close());
 await page.addInitScript(user=>localStorage.setItem('solpouch.session',JSON.stringify({token:'fixture',user})),user);
 await page.route('**/auth/me',r=>r.fulfill({json:{user}}));
 await page.route('**/pouches',r=>r.fulfill({json:[]}));
 await page.route('**/orders',r=>r.fulfill({json:orders}));
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/chat/status',r=>r.fulfill({json:{mode:'demo'}}));
 await before(page);
 await page.goto(`${origin}/dashboard`);
 await page.getByRole('button',{name:'Ask Solpouch',exact:true}).click();
 return page;
}
test('cart payment needs an explicit click and shows the resulting status',async t=>{
 let calls=0;const page=await setup(t,[draft]);
 await page.route('**/orders/cartfixture/confirm',r=>{calls++;return r.fulfill({json:{...draft,status:'paid',txSignature:'mockfixture',paidAt:new Date().toISOString()}});});
 await page.getByRole('tab',{name:/^Carts/}).click();
 const cards=page.getByRole('region',{name:'Recent carts and payments'});
 await cards.getByText('1 × Eggs · $5.00',{exact:true}).waitFor();assert.equal(calls,0);
 await cards.getByRole('button',{name:'Approve 5.00 USDC & pay',exact:true}).click();
 await cards.getByText('paid',{exact:true}).waitFor();assert.equal(calls,1);
 assert.equal(await cards.getByRole('button',{name:/Approve/}).count(),0);
});
test('web references show retailer links and never offer payment',async t=>{
 const page=await setup(t,[{...draft,merchantId:'web:store.example',store:{name:'Store',domain:'store.example'},fulfillment:{via:'instacart',label:'Instacart',checkoutUrl:'https://www.instacart.com/list/fixture'}}]);
 await page.getByRole('tab',{name:/^Carts/}).click();
 const cards=page.getByRole('region',{name:'Recent carts and payments'});
 await cards.getByText('5.00 CAD estimate',{exact:true}).waitFor();
 assert.equal(await cards.getByRole('button',{name:/Approve/}).count(),0);
 assert.equal(await cards.getByRole('link',{name:'Open retailer checkout ↗'}).getAttribute('href'),'https://www.instacart.com/list/fixture');
});
test('expired agent session closes without replaying an action',async t=>{
 let sockets=0; let closed=0;
 const page=await setup(t,[],async page=>{
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:true}}));
 await page.route('**/auth/voice-session',r=>r.fulfill({json:{token:'short-lived-fixture',signedUrl:'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture',expiresAt:new Date(Date.now()+900).toISOString()}}));
 await page.routeWebSocket(/api\.elevenlabs\.io/,ws=>{
  sockets++;ws.onClose(()=>closed++);
  ws.onMessage(raw=>{const message=JSON.parse(raw);if(message.type==='conversation_initiation_client_data')ws.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{conversation_id:'expiry-fixture',agent_output_audio_format:'pcm_16000',user_input_audio_format:'pcm_16000'}}));});
 });
 });
 await page.getByRole('textbox',{name:'Message Solpouch'}).fill('What is my balance?');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await page.getByText(/Voice session expired\. Press Talk/).waitFor();
 for(let i=0;i<20&&closed<1;i++)await page.waitForTimeout(50);
 assert.equal(sockets,1);assert.equal(closed,1);
});
test('silent agent reply times out without replaying the request', async t => {
 let messages=0;let sockets=0;
 const page=await setup(t,[],async page=>{
  await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:true}}));
  await page.route('**/auth/voice-session',r=>r.fulfill({json:{token:'timeout-fixture',signedUrl:'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture',expiresAt:new Date(Date.now()+600000).toISOString()}}));
  await page.routeWebSocket(/api\.elevenlabs\.io/,ws=>{
   sockets++;
   ws.onMessage(raw=>{const msg=JSON.parse(raw);if(msg.type==='conversation_initiation_client_data')ws.send(JSON.stringify({type:'conversation_initiation_metadata',conversation_initiation_metadata_event:{conversation_id:'timeout-fixture',agent_output_audio_format:'pcm_16000',user_input_audio_format:'pcm_16000'}}));if(msg.type==='user_message')messages++;});
  });
 });
 await page.clock.install();
 await page.getByRole('textbox',{name:'Message Solpouch'}).fill('What is my balance?');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 for(let i=0;i<30&&messages===0;i++)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(messages,1);
 await page.clock.fastForward(46000);
 await page.getByText('The agent reply timed out. Check your orders before repeating a payment request.',{exact:true}).waitFor();
 assert.equal(sockets,1);assert.equal(messages,1);
});
test('demo checkout requires preparation then a separate approval of converted amount',async t=>{
 const reference={...draft,version:4,merchantId:'web:ubereats.com',store:{name:"McDonald's",domain:'ubereats.com'},fulfillment:{via:'service',label:'Uber Eats'},total:15990000};
 const converted={...reference,version:5,total:11672700,fulfillment:{via:'demo',label:'Devnet demo checkout',demo:{sourceCurrency:'CAD',sourceTotal:15990000,sourceLines:reference.lines,usdPerCad:'0.73',payTo:'FixtureDestinationWallet',preparedAt:new Date().toISOString()}}};
 let payments=0;const page=await setup(t,[reference]);
 await page.route('**/orders/cartfixture/demo-checkout',r=>{assert.equal(r.request().postDataJSON().version,4);return r.fulfill({json:converted});});
 await page.route('**/orders/cartfixture/confirm',r=>{assert.equal(r.request().postDataJSON().version,5);payments++;return r.fulfill({json:{...converted,status:'paid'}});});
 await page.getByRole('tab',{name:/^Carts/}).click();
 const cards=page.getByRole('region',{name:'Recent carts and payments'});
 await cards.getByRole('button',{name:'Prepare devnet demo checkout'}).click();
 await cards.getByText('No retailer order is placed. Devnet test tokens only.').waitFor();
 await cards.getByText('Checkout wallet: FixtureDestinationWallet').waitFor();
 assert.equal(payments,0);
 await cards.getByRole('button',{name:'Pay demo checkout · 11.672700 test-USDC'}).click();
 await cards.getByText('paid',{exact:true}).waitFor();assert.equal(payments,1);
});
