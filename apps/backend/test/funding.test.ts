import {describe,it,expect,vi} from 'vitest';
import {SignJWT} from 'jose';
import {MemoryFundingRepository} from '../src/funding/repository.js';
import {startFunding,applyFundingEvent} from '../src/funding/service.js';
import {createHostedSession,verifyWebhook,readProviderOrder,type TransakConfig,type TransakEvent} from '../src/funding/transak.js';
import type {FundingRequest} from '../src/funding/types.js';
import {verifyMainnetUsdcReceipt,MAINNET_USDC_MINT} from '../src/funding/verification.js';
const wallet='11111111111111111111111111111111';
const config:TransakConfig={apiKey:'fixture-key',accessToken:'fixture-access-token-long-enough-for-tests',referrerDomain:'localhost',environment:'staging',capabilities:new Set(['CA:BUY','US:BUY','CA:SELL'])};
const record:FundingRequest={id:'12345678-1234-4234-8234-123456789012',owner:'a@example.test',wallet,idempotencyKey:'12345678-1234-4234-8234-123456789013',country:'CA',currency:'CAD',direction:'BUY',amount:'25',environment:'staging',status:'created',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const event=(status='COMPLETED'):TransakEvent=>({eventID:'ORDER_COMPLETED',webhookData:{id:'provider-1',partnerOrderId:record.id,status,walletAddress:wallet,countryCode:'CA',fiatCurrency:'CAD',fiatAmount:'25',cryptoCurrency:'USDC',network:'solana',isBuyOrSell:'BUY',cryptoAmount:'17.5',transactionHash:'fixture-tx'}});
const response=()=>new Response(JSON.stringify({data:{widgetUrl:'https://global-stg.transak.com/?sessionId=fixture'}}));
const store={getUser:vi.fn(async()=>({email:record.owner,wallet,createdAt:'',updatedAt:''}))};
describe('funding session safety',()=>{
 it('uses server-owned destination and opaque request ID with required provider headers',async()=>{
  const fetcher=vi.fn(async()=>response());await createHostedSession(record,'127.0.0.1',config,fetcher);
  const args=fetcher.mock.calls[0] as unknown as [string,RequestInit];const body=JSON.parse(args[1].body as string);
  expect(body.widgetParams).toMatchObject({walletAddress:wallet,partnerOrderId:record.id,fiatCurrency:'CAD',network:'solana',productsAvailed:'BUY',disableWalletAddressForm:true});
  expect(JSON.stringify(body)).not.toContain(record.owner);expect(args[1].headers).toMatchObject({'x-user-ip':'127.0.0.1','access-token':config.accessToken});
 });
 it('rejects production, unsupported routes, missing config and unsafe provider URLs',async()=>{
  await expect(createHostedSession(record,'127.0.0.1',{...config,environment:'production'})).rejects.toThrow('Real-money');
  await expect(createHostedSession(record,'unknown',config)).rejects.toThrow('network');
  await expect(createHostedSession(record,'127.0.0.1',{...config,apiKey:''})).rejects.toThrow('configured');
  await expect(createHostedSession(record,'127.0.0.1',{...config,capabilities:new Set()})).rejects.toThrow('region');
  await expect(createHostedSession(record,'127.0.0.1',config,async()=>new Response(JSON.stringify({data:{widgetUrl:'https://evil.test/?sessionId=a'}})))).rejects.toThrow('invalid checkout');
 });
 it('persists before provider work and concurrent retries only create one hosted session',async()=>{
  const repo=new MemoryFundingRepository();const fetcher=vi.fn(async()=>{expect((await repo.list(record.owner)).length).toBe(1);return response();});
  const input={country:record.country,direction:record.direction,amount:record.amount,idempotencyKey:record.idempotencyKey};
  const results=await Promise.all([startFunding(repo,store,record.owner,input,'127.0.0.1',config,fetcher),startFunding(repo,store,record.owner,input,'127.0.0.1',config,fetcher)]);
  expect(fetcher).toHaveBeenCalledTimes(1);expect(results.filter(r=>r.widgetUrl)).toHaveLength(1);
  await expect(startFunding(repo,store,record.owner,{...input,amount:'26'},'127.0.0.1',config,fetcher)).rejects.toThrow('different');
 });
 it('lost response is persistent uncertainty and a retry never invokes provider again',async()=>{
  const repo=new MemoryFundingRepository();const fetcher=vi.fn(async()=>{throw new Error('timeout');});const input={country:record.country,direction:record.direction,amount:'25',idempotencyKey:record.idempotencyKey};
  await expect(startFunding(repo,store,record.owner,input,'127.0.0.1',config,fetcher)).rejects.toThrow('did not respond');
  const again=await startFunding(repo,store,record.owner,input,'127.0.0.1',config,fetcher);expect(again.request.status).toBe('session_uncertain');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('requires a verified linked wallet',async()=>{await expect(startFunding(new MemoryFundingRepository(),{getUser:async()=>undefined},record.owner,{country:'CA',direction:'BUY',amount:'25',idempotencyKey:record.idempotencyKey},'127.0.0.1',config)).rejects.toThrow('Link and verify');});
});
describe('funding callbacks and recovery',()=>{
 it('verifies signed JWT and rejects wrong secret and disallowed algorithms',async()=>{
  const key=new TextEncoder().encode(config.accessToken);const jwt=await new SignJWT(event()).setProtectedHeader({alg:'HS256'}).setExpirationTime('5m').sign(key);
  expect((await verifyWebhook(jwt,config)).webhookData.id).toBe('provider-1');
  await expect(verifyWebhook(jwt,{...config,accessToken:'wrong'})).rejects.toThrow('Invalid');
  const other=await new SignJWT(event()).setProtectedHeader({alg:'HS384'}).sign(key);await expect(verifyWebhook(other,config)).rejects.toThrow('Invalid');
 });
 it('replays and out-of-order events cannot downgrade completion or create real credit',async()=>{
  const repo=new MemoryFundingRepository();await repo.create(record);
  expect((await applyFundingEvent(repo,event())).status).toBe('sandbox_completed');
  await applyFundingEvent(repo,event());await applyFundingEvent(repo,event('PROCESSING'));await applyFundingEvent(repo,event('FAILED'));
  expect((await repo.get(record.id))?.status).toBe('sandbox_completed');
  expect((await applyFundingEvent(repo,event('REFUNDED'))).status).toBe('refunded');
 });
 it('rejects mismatched wallet, amount, region and reused provider order or receipt',async()=>{
  const repo=new MemoryFundingRepository();await repo.create(record);
  for(const patch of [{walletAddress:'other'},{fiatAmount:'30'},{countryCode:'US'}]) await expect(applyFundingEvent(repo,{...event(),webhookData:{...event().webhookData,...patch} as TransakEvent['webhookData']})).rejects.toThrow('match');
  await applyFundingEvent(repo,event());const second={...record,id:'12345678-1234-4234-8234-123456789014',idempotencyKey:'another'};await repo.create(second);
  await expect(applyFundingEvent(repo,{...event(),webhookData:{...event().webhookData,partnerOrderId:second.id}})).rejects.toThrow('already claimed');
 });
 it('SELL tracking does not treat a payout notification as a BUY deposit',async()=>{
  const repo=new MemoryFundingRepository();await repo.create({...record,direction:'SELL',amount:'17.5'});
  expect((await applyFundingEvent(repo,{...event(),webhookData:{...event().webhookData,isBuyOrSell:'SELL'}})).status).toBe('sandbox_completed');
 });
 it('provider polling recovers missed notification by opaque partner ID',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:[{...event().webhookData,id:undefined,_id:'provider-1'}]})));
  expect((await readProviderOrder(record,config,fetcher))?.webhookData.id).toBe('provider-1');
  expect(String((fetcher.mock.calls[0] as unknown as [URL])[0])).toContain('partnerOrderId');
  await expect(readProviderOrder(record,config,async()=>new Response(JSON.stringify({data:[event().webhookData,event().webhookData]})))).rejects.toThrow('Multiple');
  for(const invalid of [null,42,'bad',[]]) await expect(readProviderOrder(record,config,async()=>new Response(JSON.stringify({data:[invalid]})))).rejects.toMatchObject({status:503});
 });
 it('finalized mainnet verification checks canonical mint and exact destination net amount',async()=>{
  const balance={accountIndex:0,mint:MAINNET_USDC_MINT,owner:wallet,uiTokenAmount:{amount:'17500000',decimals:6,uiAmount:17.5,uiAmountString:'17.5'}};
  const rpc={getGenesisHash:vi.fn(async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),getParsedTransaction:vi.fn(async()=>({meta:{err:null,preTokenBalances:[],postTokenBalances:[balance]}}))};
  expect(await verifyMainnetUsdcReceipt(rpc as never,'1'.repeat(88),wallet,'17.5')).toBe(true);
  expect(await verifyMainnetUsdcReceipt(rpc as never,'1'.repeat(88),wallet,'18')).toBe(false);
  expect(rpc.getParsedTransaction.mock.calls[0]).toEqual(['1'.repeat(88),{commitment:'finalized',maxSupportedTransactionVersion:0}]);
  rpc.getGenesisHash.mockResolvedValue('devnet');await expect(verifyMainnetUsdcReceipt(rpc as never,'1'.repeat(88),wallet,'17.5')).rejects.toThrow('mainnet RPC');
 });
});
