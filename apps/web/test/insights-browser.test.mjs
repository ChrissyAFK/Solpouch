// Browser fixtures only; no bank, retailer or blockchain calls.
import assert from 'node:assert/strict';
import {after,test} from 'node:test';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'chrome',headless:true});after(()=>browser.close());
const origin=process.env.WEB_TEST_URL??'http://localhost:3016';
const user={email:'insights@example.test',name:'Insights'};
const pouch={id:'grocery',address:'demo',name:'Groceries',balance:10_000_000,dailyLimit:100_000_000,spentToday:20_000_000,maxPerOrder:30_000_000,allowedMerchantIds:[],frozen:false};
const now=Date.now();const day=86400000;const today=Math.floor(now/day)*day;
const order=(id,total,date)=>({id,pouchId:'grocery',merchantId:'mountain-market',request:'eggs',lines:[],total,status:'paid',createdAt:date,paidAt:date,txSignature:`mock${id}`});
async function setup(t,pouches,orders){
 const page=await browser.newPage();t.after(()=>page.close());
 await page.addInitScript(user=>localStorage.setItem('solpouch.session',JSON.stringify({token:'insights-test',user})),user);
 await page.route('http://localhost:8787/**',r=>{
  const path=new URL(r.request().url()).pathname;
  const json=path==='/auth/me'?{user}:path==='/auth/voice-status'?{enabled:false}:path==='/pouches'?pouches:path==='/orders'?orders:[];
  return r.fulfill({json});
 });return page;
}
test('insights exclude unpaid/retailer/undated orders and cap spending by balance and frozen state',async t=>{
 const date=new Date(now-1000).toISOString();
 const orders=[order('paid',20_000_000,date),{...order('draft',99_000_000,date),status:'draft'},{...order('web',99_000_000,date),merchantId:'web:example.com'},{...order('old',99_000_000,date),paidAt:undefined}];
 const page=await setup(t,[pouch,{...pouch,id:'frozen',name:'Frozen groceries',balance:1_000_000_000,frozen:true}],orders);
 await page.goto(`${origin}/dashboard`);
 const section=page.getByRole('region',{name:'Pouch spending insights'});
 await section.getByTestId('period-spend').waitFor();
 assert.match(await section.getByTestId('period-spend').innerText(),/20\.00/);
 assert.match(await section.getByTestId('available-today').innerText(),/10\.00/);
 await section.getByText(/Includes 1 simulated payment/).waitFor({state:'attached'});
 await section.getByText(/1 payment with an old or invalid date was left out/).waitFor({state:'attached'});
});
test('7 and 30 day filters use paid date rather than draft creation date',async t=>{
 const oldDate=new Date(today-10*day).toISOString();
 const orders=[{...order('paid',7_000_000,new Date(now-1000).toISOString()),createdAt:oldDate},order('older',9_000_000,oldDate)];
 const page=await setup(t,[pouch],orders);await page.goto(`${origin}/dashboard`);
 await page.getByTestId('period-spend').waitFor();assert.match(await page.getByTestId('period-spend').innerText(),/7\.00/);
 await page.getByLabel('Spending period').selectOption('30');assert.match(await page.getByTestId('period-spend').innerText(),/16\.00/);
});
test('first pouch setup saves explicit limits and offers a shopping list next',async t=>{
 const pouches=[];const page=await setup(t,pouches,[]);let body;
 await page.route('**/pouches',r=>{
  if(r.request().method()==='POST'){body=r.request().postDataJSON();pouches.push({...pouch,name:body.name});return r.fulfill({json:pouches[0]});}
  return r.fulfill({json:pouches});
 });
 await page.goto(`${origin}/dashboard`);await page.getByRole('button',{name:'Set up a pouch',exact:true}).click();
 await page.getByLabel('Pouch name',{exact:true}).fill('Weekly groceries');
 await page.getByLabel('Per-order limit · USDC',{exact:true}).fill('25');
 await page.getByLabel('Daily limit · USDC',{exact:true}).fill('50');
 await page.getByRole('button',{name:'Create my first pouch'}).click();
 await page.getByRole('link',{name:'Make a shopping list',exact:true}).waitFor();
 assert.equal(body.confirmAbove,0);assert.equal(body.maxPerOrder,25_000_000);assert.equal(body.dailyLimit,50_000_000);
});
