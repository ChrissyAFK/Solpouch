// Intercepted API fixtures: UI behavior only; no real checkout or purchases.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3003';
const user = { email:'lists@example.test', name:'List tester' };
const pouch = {id:'groceries',name:'Groceries',balance:50000000,dailyLimit:50000000,spentToday:0,maxPerOrder:50000000,frozen:false,allowedMerchantIds:[]};
const product = { id:'eggs',merchantId:'market',name:'Eggs',unitPrice:5000000,inStock:true };
const draft = {id:'cart',version:1,pouchId:pouch.id,merchantId:'market',status:'draft',request:'eggs',total:5000000,createdAt:new Date().toISOString(),lines:[{requested:'eggs',requestedQty:1,qty:1,lineTotal:5000000,product,matchScore:1,substitution:false}]};
async function setup(t) {
 const page=await browser.newPage();t.after(()=>page.close());
 await page.addInitScript(user=>localStorage.setItem('solpouch.session',JSON.stringify({token:'fixture',user})),user);
 await page.route('**/auth/me',r=>r.fulfill({json:{user}}));
 await page.route('**/auth/voice-status',r=>r.fulfill({json:{enabled:false}}));
 await page.route('**/shopping-lists/status',r=>r.fulfill({json:{temporary:true}}));
 await page.route('**/pouches',r=>r.fulfill({json:[pouch]}));
 await page.route('**/orders',r=>r.fulfill({json:[]}));
 await page.route('**/merchants',r=>r.fulfill({json:[{id:'market',name:'Market'}]}));
 await page.route('**/merchants/market/products',r=>r.fulfill({json:[product]}));
 return page;
}
test('saved list CRUD persists server data and delete handles 204',async t=>{
 const page=await setup(t);let saved=[];let deletion;
 await page.route('**/shopping-lists',r=>{if(r.request().method()==='POST'){const body=r.request().postDataJSON();saved=[{...body,id:'weekly',version:1}];return r.fulfill({status:201,json:saved[0]});}return r.fulfill({json:saved});});
 await page.route('**/shopping-lists/weekly',r=>{if(r.request().method()==='DELETE'){deletion=r.request().postDataJSON();saved=[];return r.fulfill({status:204});}const body=r.request().postDataJSON();saved=[{...body,id:'weekly',version:2}];return r.fulfill({json:saved[0]});});
 await page.goto(`${origin}/lists`);await page.getByLabel('List name').fill('Weekly');await page.getByRole('textbox',{name:'Item 1',exact:true}).fill('eggs');await page.getByRole('button',{name:'Save list',exact:true}).click();await page.getByText('List saved.',{exact:true}).waitFor();
 await page.getByText('Lists in this demo reset when the server restarts.',{exact:true}).waitFor();assert.equal(saved[0].items[0].qty,1);await page.reload();await page.getByRole('heading',{name:'Weekly',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Quantity 1',{exact:true}).fill('2');await page.getByRole('button',{name:'Save list',exact:true}).click();await page.getByText('2 × eggs',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Delete list',exact:true}).click();await page.getByText('List deleted.',{exact:true}).waitFor();assert.equal(deletion.version,2);
});
test('reusing a list opens a fresh draft without payment',async t=>{
 const page=await setup(t);let body;await page.route('**/shopping-lists',r=>r.fulfill({json:[{id:'weekly',version:4,name:'Weekly',items:[{name:'eggs',qty:1}]}]}));
 await page.route('**/shopping-lists/weekly/draft',r=>{body=r.request().postDataJSON();return r.fulfill({json:draft});});await page.route('**/orders/cart',r=>r.fulfill({json:draft}));
 await page.goto(`${origin}/lists`);await page.getByRole('button',{name:'Build cart',exact:true}).click();await page.getByRole('heading',{name:'Review order',exact:true}).waitFor();assert.equal(body.version,4);assert.equal(new URL(page.url()).searchParams.get('order'),'cart');
});
test('cart edits block approval and submit reviewed version after save',async t=>{
 const page=await setup(t);let order=draft;let edit;let approval;
 await page.route('**/orders/cart',r=>{if(r.request().method()==='PATCH'){edit=r.request().postDataJSON();order={...draft,version:2,total:10000000,lines:[{...draft.lines[0],qty:2,lineTotal:10000000}]};}return r.fulfill({json:order});});
 await page.route('**/orders/cart/confirm',r=>{approval=r.request().postDataJSON();return r.fulfill({json:{...order,status:'paid',paidAt:new Date().toISOString(),txSignature:'mock'}});});
 await page.goto(`${origin}/order?order=cart`);await page.getByLabel('Cart quantity 1',{exact:true}).fill('2');assert.equal(await page.getByRole('button',{name:/Approve .* & pay/}).isDisabled(),true);
 await page.getByRole('button',{name:'Save cart changes',exact:true}).click();await page.getByRole('button',{name:'Approve $10.00 & pay',exact:true}).click();assert.equal(edit.version,1);assert.equal(edit.lines[0].qty,2);assert.equal(approval.version,2);
});
test('rejected cart edit retains input and cannot pay stale total',async t=>{
 const page=await setup(t);await page.route('**/orders/cart',r=>r.request().method()==='PATCH'?r.fulfill({status:409,json:{error:'This cart changed. Refresh before editing.',code:'RecordChanged'}}):r.fulfill({json:draft}));
 await page.goto(`${origin}/order?order=cart`);await page.getByLabel('Cart quantity 1',{exact:true}).fill('3');await page.getByRole('button',{name:'Save cart changes',exact:true}).click();await page.getByText('This cart changed. Refresh before editing.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Cart quantity 1',{exact:true}).inputValue(),'3');assert.equal(await page.getByRole('button',{name:/Approve .* & pay/}).isDisabled(),true);
});
test('handed-off cart remains editable and hides stale checkout while editing',async t=>{
 const page=await setup(t);let order={...draft,fulfillment:{via:'instacart',label:'Instacart',checkoutUrl:'https://www.instacart.com/list/old',linkStatus:'ready'}};
 await page.route('**/orders/cart',r=>{if(r.request().method()==='PATCH')order={...order,version:2,total:10000000,lines:[{...draft.lines[0],qty:2,lineTotal:10000000}],fulfillment:{via:'instacart',label:'Instacart',linkStatus:'unavailable'}};return r.fulfill({json:order});});
 await page.goto(`${origin}/order?order=cart`);await page.getByRole('link',{name:'Open Instacart cart',exact:true}).waitFor();assert.equal(await page.getByLabel('Product 1',{exact:true}).count(),0);
 await page.getByLabel('Cart quantity 1',{exact:true}).fill('2');assert.equal(await page.getByRole('link',{name:'Open Instacart cart',exact:true}).count(),0);await page.getByRole('button',{name:'Save cart changes',exact:true}).click();await page.getByText('The shopping link is unavailable. Try creating it again.',{exact:true}).waitFor();assert.equal(await page.getByRole('link',{name:'Open Instacart cart',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Complete checkout with the retailer',exact:true}).isDisabled(),true);
});
