import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStripeRepository, StripeBusy, type StripeFundingRequest } from '../src/stripe/repository.js';
import { postgresPoolConfig } from '../src/store/postgres.js';

const url=process.env.POSTGRES_INTEGRATION_URL;
const schema=`stripe_it_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool, poolA:pg.Pool, poolB:pg.Pool, a:PostgresStripeRepository,b:PostgresStripeRepository;
const fixture=(id=randomUUID()):StripeFundingRequest=>({id,provider:'stripe',owner:'stripe@example.com',idempotencyKey:id,wallet:'fixture-wallet',amountCad:'25.00',amountCents:2500,usdPerCad:'0.73',usdcAmount:'18.250000',usdcMicros:18250000,status:'paid',createdAt:new Date().toISOString()});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

describe.skipIf(!url)('Stripe isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  if(!['localhost','127.0.0.1','[::1]'].includes(new URL(url!).hostname))throw Error('Local database required');
  admin=new pg.Pool(postgresPoolConfig(url!));await admin.query(`CREATE SCHEMA ${schema}`);
  poolA=new pg.Pool({...postgresPoolConfig(url!),options:`-c search_path=${schema}`,max:5,connectionTimeoutMillis:1000,application_name:`${schema}_a`});
  poolB=new pg.Pool({...postgresPoolConfig(url!),options:`-c search_path=${schema}`,application_name:`${schema}_b`});
  a=new PostgresStripeRepository(poolA);b=new PostgresStripeRepository(poolB);await a.initialize();await b.initialize();
 });
 afterAll(async()=>{await poolA?.end();await poolB?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
 it('concurrent creates return one immutable request for an owner and idempotency key',async()=>{
  const one=fixture();const [x,y]=await Promise.all([a.create(one),b.create({...one,id:randomUUID()})]);expect(x.id).toBe(y.id);
  expect((await a.list(one.owner)).filter(r=>r.idempotencyKey===one.idempotencyKey)).toHaveLength(1);
 });
 it('serializes webhook and poll across independent pools',async()=>{
  const r=await a.create(fixture()),entered=deferred(),release=deferred();
  const locked=a.withLock(r.id,async()=>{entered.resolve();await release.promise;await a.update(r.id,x=>({...x,status:'confirmed',txSignature:`sig-${r.id}`}));});
  await entered.promise;await expect(b.withLock(r.id,async()=>{})).rejects.toBeInstanceOf(StripeBusy);release.resolve();await locked;
  expect(await b.withLock(r.id,()=>b.get(r.id))).toMatchObject({status:'confirmed'});
 });
 it('retains signed journal after confirmation persistence fails and across repository reconstruction',async()=>{
  const r=await a.create(fixture());const operation={requestId:r.id,wallet:r.wallet,mint:'test-mint',amountMicros:'18250000',signature:`sig-${r.id}`,rawTransaction:'signed-fixture',lastValidBlockHeight:100};
  await a.update(r.id,x=>({...x,mintOperation:operation}));
  await admin.query(`CREATE FUNCTION ${schema}.reject_confirm() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'status'='confirmed' THEN RAISE EXCEPTION 'injected storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_confirm BEFORE UPDATE ON ${schema}.stripe_funding_requests FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_confirm()`);
  await expect(a.update(r.id,x=>({...x,status:'confirmed',txSignature:operation.signature}))).rejects.toThrow('injected');
  expect((await new PostgresStripeRepository(poolB).get(r.id))!.mintOperation).toEqual(operation);
  await admin.query(`DROP TRIGGER reject_confirm ON ${schema}.stripe_funding_requests`);
  await b.update(r.id,x=>({...x,status:'confirmed',txSignature:x.mintOperation!.signature}));
  expect((await a.get(r.id))!.txSignature).toBe(operation.signature);
 });
 it('does not let two requests claim the same Checkout session or mint receipt',async()=>{
  const x=await a.create(fixture()),y=await b.create(fixture());const sessionId=`cs_test_${x.id}`;
  await a.update(x.id,r=>({...r,sessionId,txSignature:`same-${x.id}`}));
  await expect(b.update(y.id,r=>({...r,sessionId}))).rejects.toThrow();
  await expect(b.update(y.id,r=>({...r,txSignature:`same-${x.id}`}))).rejects.toThrow();
 });
 it('five concurrent independent requests reuse their lock connections without pool starvation',async()=>{
  const records=await Promise.all(Array.from({length:5},()=>a.create(fixture())));
  let entered=0;const all=deferred();
  await Promise.all(records.map(r=>a.withLock(r.id,async()=>{
    if(++entered===5)all.resolve();await all.promise;
    expect(await a.get(r.id)).toBeDefined();
    await a.update(r.id,x=>({...x,status:'confirmed',txSignature:`concurrent-${r.id}`}));
  })));
 });
 it('fails closed after losing the lock connection and allows recovery',async()=>{
  const r=await a.create(fixture()),entered=deferred(),release=deferred();
  const locked=a.withLock(r.id,async()=>{entered.resolve();await release.promise;return a.update(r.id,x=>({...x,status:'confirmed'}));});
  const rejection=expect(locked).rejects.toThrow('lock connection');await entered.promise;
  const clients=await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_try_advisory_lock%'",[`${schema}_a`]);expect(clients.rows.length).toBeGreaterThan(0);
  await admin.query('SELECT pg_terminate_backend($1)',[clients.rows[0].pid]);await new Promise(r=>setTimeout(r,100));release.resolve();await rejection;
  expect((await b.get(r.id))!.status).toBe('paid');await expect(b.withLock(r.id,async()=>true)).resolves.toBe(true);
 });
});
