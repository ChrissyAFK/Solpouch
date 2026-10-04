/** Opt-in local PostgreSQL; provider events are explicit fixtures, never live payments. */
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {applyFundingEvent} from '../src/funding/service.js';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PostgresFundingRepository} from '../src/funding/repository.js';
import {postgresPoolConfig} from '../src/store/postgres.js';
import type {FundingRequest} from '../src/funding/types.js';
const url=process.env.POSTGRES_INTEGRATION_URL;
const restartBinary=process.env.POSTGRES_INTEGRATION_PG_CTL;
const restartDataDir=process.env.POSTGRES_INTEGRATION_DATA_DIR;
const schema=`funding_it_${randomBytes(8).toString('hex')}`;
let admin:pg.Pool;const pools:pg.Pool[]=[];
function connect() {const pool=new pg.Pool({...postgresPoolConfig(url!),options:`-c search_path=${schema}`});pools.push(pool);return new PostgresFundingRepository(pool);}
const fixture=():FundingRequest=>({id:randomUUID(),owner:'fixture@example.test',idempotencyKey:randomUUID(),country:'US',currency:'USD',direction:'BUY',amount:'25',wallet:'11111111111111111111111111111111',environment:'staging',status:'created',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
describe.skipIf(!url)('funding real PostgreSQL persistence',()=>{
 beforeAll(async()=>{if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url!).hostname)) throw new Error('Local database only');admin=new pg.Pool(postgresPoolConfig(url!));await admin.query(`CREATE SCHEMA ${schema}`);await connect().initialize();});
 afterAll(async()=>{await Promise.all(pools.map(p=>p.end()));if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
 it('concurrent connections create exactly one request and reconnect recovers it',async()=>{const record=fixture();const a=connect(),b=connect();const out=await Promise.all([a.create(record),b.create({...record,id:randomUUID()})]);expect(out.filter(r=>r.created)).toHaveLength(1);expect(out[0].request.id).toBe(out[1].request.id);expect((await connect().get(out[0].request.id))?.amount).toBe('25');});
 it('row locks serialize updates and failed writes roll back',async()=>{const a=connect(),b=connect(),record=fixture();await a.create(record);await Promise.all([a.update(record.id,r=>({...r,message:(Number(r.message??0)+1).toString()})),b.update(record.id,r=>({...r,message:(Number(r.message??0)+1).toString()}))]);expect((await a.get(record.id))?.message).toBe('2');await expect(a.update(record.id,()=>{throw new Error('fixture failure');})).rejects.toThrow('fixture failure');expect((await b.get(record.id))?.message).toBe('2');});
 it('provider IDs cannot be claimed twice but sandbox dummy signatures can',async()=>{const repo=connect(),a=fixture(),b=fixture();await repo.create(a);await repo.create(b);await repo.update(a.id,r=>({...r,status:'sandbox_completed',providerOrderId:'provider-unique',txSignature:'DUMMY_TX_ID'}));await expect(repo.update(b.id,r=>({...r,providerOrderId:'provider-unique'}))).rejects.toThrow();expect((await repo.get(b.id))?.providerOrderId).toBeUndefined();await repo.update(b.id,r=>({...r,status:'sandbox_completed',providerOrderId:'different-provider',txSignature:'DUMMY_TX_ID'}));expect((await repo.get(b.id))?.status).toBe('sandbox_completed');});
 it('times out a contended row lock and allows a later retry',async()=>{
  const record=fixture(),repo=connect();await repo.create(record);
  const blocker=await admin.connect();
  try {
   await blocker.query('BEGIN');
   await blocker.query(`SELECT id FROM ${schema}.funding_requests WHERE id=$1 FOR UPDATE`,[record.id]);
   await expect(repo.update(record.id,r=>({...r,status:'processing'}))).rejects.toMatchObject({code:'55P03'});
   expect((await repo.get(record.id))?.status).toBe('created');
  } finally {await blocker.query('ROLLBACK');blocker.release();}
  expect((await repo.update(record.id,r=>({...r,status:'processing'}))).status).toBe('processing');
 },15000);
 it.skipIf(!restartBinary || !restartDataDir)('survives an actual database process restart and applies a delayed callback once',async()=>{
  const dirs=await admin.query('SHOW data_directory');
  expect(realpathSync(dirs.rows[0].data_directory)).toBe(realpathSync(restartDataDir!));
  const record=fixture();const prior=connect();await prior.create(record);
  await prior.update(record.id,r=>({...r,status:'session_uncertain',message:'fixture response lost'}));
  const started=await admin.query('SELECT pg_postmaster_start_time() AS started');
  await Promise.all(pools.splice(0).map(pool=>pool.end()));await admin.end();
  try {execFileSync(restartBinary!,['-D',restartDataDir!,'-l',join(restartDataDir!,'funding-integration-restart.log'),'-m','fast','-w','restart'],{timeout:15000,stdio:'ignore'});}
  finally {admin=new pg.Pool(postgresPoolConfig(url!));}
  const restarted=await admin.query('SELECT pg_postmaster_start_time() AS started');
  expect(restarted.rows[0].started.getTime()).toBeGreaterThan(started.rows[0].started.getTime());
  const repo=connect();expect((await repo.get(record.id))?.status).toBe('session_uncertain');
  const retry=await repo.create({...record,id:randomUUID()});expect(retry.created).toBe(false);expect(retry.request.id).toBe(record.id);
  const event={eventID:'ORDER_COMPLETED',webhookData:{id:'restart-provider-order',partnerOrderId:record.id,status:'COMPLETED',walletAddress:record.wallet,fiatCurrency:record.currency,cryptoCurrency:'USDC' as const,network:'solana' as const,isBuyOrSell:record.direction,countryCode:record.country,fiatAmount:record.amount,cryptoAmount:'25',transactionHash:'DUMMY_RESTART_TX'}};
  const results=await Promise.all([applyFundingEvent(repo,event),applyFundingEvent(connect(),event)]);
  expect(results.every(result=>result.status==='sandbox_completed')).toBe(true);
  expect((await repo.list(record.owner)).filter(r=>r.id===record.id)).toHaveLength(1);
 },20000);
});
