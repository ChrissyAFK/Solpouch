/**
 * Opt-in, isolated real PostgreSQL tests. Example:
 * POSTGRES_INTEGRATION_URL=postgres://user@127.0.0.1:55439/postgres?sslmode=disable pnpm --filter @solpouch/backend test test/postgres.integration.test.ts
 *
 * A fresh schema is created and dropped on the supplied LOCAL database. The
 * Timescale-only statements are deliberately excluded: these tests validate the
 * production store's relational operations, not Timescale migrations/analytics.
 * Actual database-process restart additionally requires POSTGRES_INTEGRATION_PG_CTL
 * and POSTGRES_INTEGRATION_DATA_DIR pointing at this isolated test server.
 * RPC is an explicit fixture; no blockchain requests or transfers are made.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockVaultClient } from "../src/vault/mock.js";
import { getMerchant } from "../src/merchants/index.js";
import type { StoredPouch } from "../src/store/types.js";
import type { Pouch } from "@solpouch/shared";
import { PostgresStore, postgresPoolConfig } from "../src/store/postgres.js";
import { StoreConflictError, type VaultOperation } from "../src/store/types.js";
import { recoverTransaction, type RecoveryTransport } from "../src/vault/recovery.js";
import { confirmOrder } from "../src/services/orders.js";
import { completeTopUp } from "../src/services/topups.js";
import type { VaultClient } from "../src/vault/types.js";

const url = process.env.POSTGRES_INTEGRATION_URL;
const restartBinary = process.env.POSTGRES_INTEGRATION_PG_CTL;
const restartDataDir = process.env.POSTGRES_INTEGRATION_DATA_DIR;
const schema = `solpouch_it_${randomBytes(8).toString("hex")}`;
const stores: PostgresStore[] = [];
let admin: pg.Pool;
let a: PostgresStore;
let b: PostgresStore;
const fixturePouch = (id: string): StoredPouch => ({ id, address: `addr-${id}`, name: "Integration test", balance: 10_000_000, maxPerOrder: 5_000_000, dailyLimit: 10_000_000, spentToday: 0, confirmAbove: 0, allowedMerchantIds: ["thai-express"], frozen: false, ownerEmail: "test@example.com" });
const operation = (id: string, kind: "pay" | "topup", pouchId: string): VaultOperation => ({ id, kind, pouchId, txSignature: `fixture-signature-${id}`, signedTransaction: Buffer.from(`fixture-signed-bytes-${id}`).toString("base64"), lastValidBlockHeight: 100, createdAt: new Date().toISOString() });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const timeout = (ms: number) => new Promise(r => setTimeout(r, ms));

function connectStore() {
  const pool = new pg.Pool({ ...postgresPoolConfig(url!), options: `-c search_path=${schema}`, application_name: schema });
  // Bypass only connect()'s Timescale migration, using its exact production pool
  // configuration and constructor. Every tested Store method is production code.
  const StoreConstructor = PostgresStore as unknown as new (pool: pg.Pool) => PostgresStore;
  const store = new StoreConstructor(pool);
  stores.push(store);
  return store;
}
function rpcFixture() {
  let confirmed = false;
  const rpc: RecoveryTransport = {
    status: vi.fn(async () => ({ confirmed, failed: false })),
    blockHeight: vi.fn(async () => 50),
    broadcast: vi.fn(async () => { confirmed = true; }),
    confirm: vi.fn(async () => ({ failed: false })),
  };
  return rpc;
}
function fixtureVault(store: PostgresStore, rpc: RecoveryTransport): VaultClient {
  return {
    pay: (pouch: Pouch, _merchant: string, _amount: number, id: string) => recoverTransaction(store, `pay:${id}`, rpc, async () => operation(`pay:${id}`, "pay", pouch.id), { kind: "pay", pouchId: pouch.id }),
    topUp: (pouchId: string, _amount: number, id: string) => recoverTransaction(store, `topup:${id}`, rpc, async () => operation(`topup:${id}`, "topup", pouchId), { kind: "topup", pouchId }),
  } as VaultClient;
}

describe.skipIf(!url)("isolated real PostgreSQL (relational schema; fixture RPC)", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("Integration tests require an explicit localhost database; remote databases are refused");
    admin = new pg.Pool(postgresPoolConfig(url!));
    await admin.query(`CREATE SCHEMA ${schema}`);
    const fullSchema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");
    const relational = fullSchema.split(";").filter(sql => !/CREATE EXTENSION IF NOT EXISTS timescaledb|SELECT create_hypertable|CREATE MATERIALIZED VIEW|SELECT add_continuous_aggregate_policy|ALTER TABLE payments SET|SELECT add_compression_policy/i.test(sql)).join(";");
    await admin.query(`SET search_path TO ${schema}; ${relational}`);
    await admin.query(`CREATE TABLE ${schema}.failure_fixture (kind text PRIMARY KEY);
      CREATE FUNCTION ${schema}.reject_fixture_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM ${schema}.failure_fixture WHERE kind = TG_ARGV[0]) THEN
          IF TG_ARGV[0] = 'journal' OR (TG_ARGV[0] = 'paid' AND to_jsonb(NEW)->>'status' = 'paid') OR (TG_ARGV[0] = 'completed' AND to_jsonb(NEW)->>'status' = 'completed') THEN
            RAISE EXCEPTION 'injected real PostgreSQL write failure';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_paid_failure BEFORE UPDATE ON ${schema}.orders FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_fixture_write('paid');
      CREATE TRIGGER fixture_topup_failure BEFORE UPDATE ON ${schema}.topups FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_fixture_write('completed');
      CREATE TRIGGER fixture_journal_failure BEFORE INSERT ON ${schema}.vault_operations FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_fixture_write('journal');`);
    a = connectStore();
    b = connectStore();
  });
  afterAll(async () => {
    await Promise.all(stores.map(store => store.close().catch(() => {})));
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("deduplicates concurrent metrics with different timestamps across pools", async () => {
    const record = {time:"2026-10-03T12:00:00.000Z",pouchId:"metrics",merchantId:"m",orderId:"o",amount:123,txSignature:"same-real-signature-fixture"};
    await Promise.all([a.recordPayment(record),b.recordPayment({...record,time:"2026-10-03T12:00:05.000Z"})]);
    const rows=await admin.query(`SELECT count(*)::int AS n FROM ${schema}.payments WHERE tx_signature=$1`,[record.txSignature]);
    expect(rows.rows[0].n).toBe(1);
  });
  it("patches profile and wallet concurrently without overwriting unrelated fields", async () => {
    const email="concurrent-profile@example.com", now=new Date().toISOString();
    await Promise.all([a.updateUser(email,{displayName:"Alice"},now),b.updateUser(email,{wallet:"fixture-wallet"},now)]);
    expect(await a.getUser(email)).toMatchObject({displayName:"Alice",wallet:"fixture-wallet"});
    await b.updateUser(email,{wallet:null},now);
    expect(await a.getUser(email)).toMatchObject({displayName:"Alice"});
    expect((await a.getUser(email))!.wallet).toBeUndefined();
  });
  it("persists rolling spend windows and top-up failure reasons",async()=>{
    const p=await a.savePouch({...fixturePouch("window-fixture"),spentToday:100,spentSince:new Date(Date.now()-25*3600_000).toISOString()});
    expect(p.spentToday).toBe(0);
    expect((await b.getPouch(p.id))!.spentToday).toBe(0);
    const now=new Date().toISOString();
    await a.saveTopUp({id:"failed-fixture",pouchId:p.id,amount:100,reason:"fixture",status:"failed",failReason:"TxFailed",readyAt:now,createdAt:now});
    expect(await b.getTopUp("failed-fixture")).toMatchObject({status:"failed",failReason:"TxFailed"});
  });
  it("rejects stale concurrent writes across independent pools", async () => {
    const saved = await a.savePouch(fixturePouch("cas"));
    const results = await Promise.allSettled([a.savePouch({ ...saved, balance: 7 }), b.savePouch({ ...saved, balance: 9 })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(StoreConflictError);
    expect((await b.getPouch(saved.id))?.version).toBe(2);
  });

  it("serializes cross-pool pouch operations and supports nested same-pouch locks", async () => {
    await a.savePouch(fixturePouch("locks"));
    const entered = deferred(); const release = deferred();
    const first = a.withPouchLock("locks", async () => {
      entered.resolve(); await release.promise;
      await a.withPouchLock("locks", async () => {
        const pouch = (await a.getPouch("locks"))!;
        await a.savePouch({ ...pouch, balance: pouch.balance + 1 });
      });
    });
    await entered.promise;
    let secondEntered = false;
    const second = b.withPouchLock("locks", async () => {
      secondEntered = true;
      const pouch = (await b.getPouch("locks"))!;
      await b.savePouch({ ...pouch, balance: pouch.balance + 1 });
    });
    await timeout(50);
    expect(secondEntered).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect((await a.getPouch("locks"))?.balance).toBe(10_000_002);
  });

  it("fails closed when the lock connection is killed and can recover on a new connection", async () => {
    const entered = deferred(); const release = deferred();
    const work = a.withPouchLock("killed", async () => { entered.resolve(); await release.promise; await a.listPouches(); });
    const outcome = expect(work).rejects.toThrow(/lost|terminated|connection/i);
    await entered.promise;
    const { rows } = await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND pid IN (SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted)", [schema]);
    expect(rows).toHaveLength(1);
    await admin.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
    await timeout(30);
    release.resolve();
    await outcome;
    await expect(b.withPouchLock("killed", async () => b.listPouches())).resolves.toBeInstanceOf(Array);
  });

  it("persists email sessions and revokes across independent pools", async()=> {
    const session={id:"fixture-session",email:"test@example.com",name:"Fixture",picture:"",createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
    await a.saveSession(session);
    expect(await b.getSession(session.id)).toEqual(session);
    expect(await b.listSessions(session.email)).toEqual([session]);
    await b.deleteSessions(session.email);
    expect(await a.getSession(session.id)).toBeUndefined();
  });

  it("stores unique linked wallets and consumes a wallet challenge only once across pools", async () => {
    const now = new Date().toISOString();
    const one = {email:"wallet-one@example.com", wallet:"fixture-wallet", createdAt:now, updatedAt:now};
    const two = {...one,email:"wallet-two@example.com"};
    const results = await Promise.allSettled([a.saveUser(one),b.saveUser(two)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect((await b.findUserByWallet("fixture-wallet"))?.email).toMatch(/^wallet-(one|two)@/);
    await a.saveChallenge({id:"challenge-fixture",wallet:"fixture-wallet",email:one.email,message:"fixture",expiresAt:new Date(Date.now()+60000).toISOString()});
    const challenges = await Promise.all([a.consumeChallenge("challenge-fixture"),b.consumeChallenge("challenge-fixture")]);
    expect(challenges.filter(Boolean)).toHaveLength(1);
  });

  it("enforces a shared atomic rate limit across pools", async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).consumeRateLimit("shared-bucket", 60_000, 7)));
    expect(results.filter(r => r.allowed)).toHaveLength(7);
    expect(results.every(r => r.retryAfterSeconds > 0)).toBe(true);
  });

  it("commits the immutable journal before fixture broadcast and survives a fresh store instance", async () => {
    const record = operation("journal-restart", "pay", "cas");
    const rpc = rpcFixture();
    rpc.broadcast = vi.fn(async () => {
      // Independent pool visibility proves the journal is committed before send.
      expect(await b.getOperation(record.id)).toEqual(record);
      throw new Error("fixture lost RPC response after send");
    });
    await expect(recoverTransaction(a, record.id, rpc, async () => record, record)).rejects.toThrow("not confirmed");
    const restarted = connectStore();
    const after = rpcFixture();
    after.status = vi.fn(async () => ({ confirmed: true, failed: false }));
    const prepare = vi.fn();
    expect(await recoverTransaction(restarted, record.id, after, prepare, record)).toEqual({ txSignature: record.txSignature });
    expect(prepare).not.toHaveBeenCalled();
    expect(after.broadcast).not.toHaveBeenCalled();
    await expect(b.saveOperation({ ...record, txSignature: "replacement" })).rejects.toBeInstanceOf(StoreConflictError);
  });

  it("does not send when an actual PostgreSQL journal insert fails", async () => {
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('journal')`);
    const record = operation("journal-failed", "pay", "cas");
    const rpc = rpcFixture();
    try {
      await expect(recoverTransaction(a, record.id, rpc, async () => record, record)).rejects.toThrow("injected real PostgreSQL");
      expect(rpc.broadcast).not.toHaveBeenCalled();
      expect(await b.getOperation(record.id)).toBeUndefined();
    } finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='journal'`); }
  });

  it("recovers paid state after a real database write rejection without resending, including concurrent confirmation", async () => {
    await a.savePouch(fixturePouch("payment"));
    await a.saveOrder({ id: "order", pouchId: "payment", merchantId: "thai-express", request: "fixture", total: 5, lines: [{requested:"fixture",requestedQty:1,qty:1,product:{id:"fixture",merchantId:"thai-express",name:"fixture",unitPrice:5,inStock:true},lineTotal:5,matchScore:1,substitution:false}], status: "draft", createdAt: new Date().toISOString() });
    const rpc = rpcFixture();
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('paid')`);
    try {
      await expect(confirmOrder({ store: a, vault: fixtureVault(a, rpc) }, "test@example.com", "order")).rejects.toThrow("recover its receipt");
      expect((await b.getOrder("order"))?.status).toBe("paying");
    } finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='paid'`); }
    const restarted = connectStore();
    const results = await Promise.all([confirmOrder({ store: restarted, vault: fixtureVault(restarted, rpc) }, "test@example.com", "order"), confirmOrder({ store: b, vault: fixtureVault(b, rpc) }, "test@example.com", "order")]);
    expect(results.every(order => order.status === "paid")).toBe(true);
    expect(results[0].txSignature).toBe(results[1].txSignature);
    expect(rpc.broadcast).toHaveBeenCalledTimes(1);
  });

  it("recovers completed top-ups after a database write rejection without a second fixture transfer", async () => {
    await a.savePouch(fixturePouch("topup-pouch"));
    await a.saveTopUp({ id: "topup", pouchId: "topup-pouch", amount: 5, reason: "fixture refill", status: "cooling_down", readyAt: new Date(0).toISOString(), createdAt: new Date().toISOString() });
    const rpc = rpcFixture();
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('completed')`);
    try {
      await expect(completeTopUp({ store: a, vault: fixtureVault(a, rpc) }, "test@example.com", "topup")).rejects.toMatchObject({ status: 503 });
      expect((await b.getTopUp("topup"))?.status).toBe("processing");
    } finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='completed'`); }
    const restarted = connectStore();
    const results = await Promise.all([completeTopUp({ store: restarted, vault: fixtureVault(restarted, rpc) }, "test@example.com", "topup"), completeTopUp({ store: b, vault: fixtureVault(b, rpc) }, "test@example.com", "topup")]);
    expect(results.every(topup => topup.status === "completed")).toBe(true);
    expect(results[0].txSignature).toBe(results[1].txSignature);
    expect(rpc.broadcast).toHaveBeenCalledTimes(1);
  });
  it.skipIf(!restartBinary || !restartDataDir)("recovers a pending top-up after an actual PostgreSQL process restart", async () => {
    // Extra opt-in: verify pg_ctl targets exactly the database used by this suite.
    const { rows } = await admin.query("SHOW data_directory");
    expect(realpathSync(rows[0].data_directory)).toBe(realpathSync(restartDataDir!));
    await a.savePouch(fixturePouch("restart-pouch"));
    await a.saveTopUp({ id: "restart-topup", pouchId: "restart-pouch", amount: 5, reason: "restart fixture", status: "cooling_down", readyAt: new Date(0).toISOString(), createdAt: new Date().toISOString() });
    const before = rpcFixture();
    before.confirm = vi.fn(async () => { throw new Error("fixture response lost after acceptance"); });
    await expect(completeTopUp({ store: a, vault: fixtureVault(a, before) }, "test@example.com", "restart-topup")).rejects.toMatchObject({ status: 503 });
    const savedJournal = await b.getOperation("topup:restart-topup");
    expect(savedJournal).toBeDefined();
    expect((await b.getTopUp("restart-topup"))?.status).toBe("processing");
    const listTime = new Date().toISOString();
    const savedList = await a.saveShoppingList({id:"restart-list",ownerEmail:"test@example.com",name:"Week",items:[{name:"milk",qty:3}],createdAt:listTime,updatedAt:listTime});
    const beforeRestart = await admin.query("SELECT pg_postmaster_start_time() AS started");
    await Promise.all(stores.splice(0).map(store => store.close()));
    await admin.end();
    try {
      execFileSync(restartBinary!, ["-D", restartDataDir!, "-l", join(restartDataDir!, "integration-restart.log"), "-m", "fast", "-w", "restart"], { timeout: 15_000, stdio: "ignore" });
    } finally { admin = new pg.Pool(postgresPoolConfig(url!)); }
    const afterRestart = await admin.query("SELECT pg_postmaster_start_time() AS started");
    expect(afterRestart.rows[0].started.getTime()).toBeGreaterThan(beforeRestart.rows[0].started.getTime());
    a = connectStore(); b = connectStore();
    expect(await b.getShoppingList("restart-list")).toEqual(savedList);
    expect(await b.getOperation("topup:restart-topup")).toEqual(savedJournal);
    const after = rpcFixture();
    after.status = vi.fn(async () => ({ confirmed: true, failed: false }));
    const recovered = await completeTopUp({ store: a, vault: fixtureVault(a, after) }, "test@example.com", "restart-topup");
    expect(recovered.status).toBe("completed");
    expect(recovered.txSignature).toBe(savedJournal!.txSignature);
    expect(before.broadcast).toHaveBeenCalledTimes(1);
    expect(after.broadcast).not.toHaveBeenCalled();
  }, 20_000);

  it("atomically persists mock balance and receipt and recovers with a new store",async()=> {
    await a.savePouch(fixturePouch("mock-durable"));
    await a.saveTopUp({id:"mock-topup",pouchId:"mock-durable",amount:5,reason:"fixture",status:"cooling_down",readyAt:new Date(0).toISOString(),createdAt:new Date().toISOString()});
    const first = new MockVaultClient(a,id=>getMerchant(id)?.payTo);
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('completed')`);
    try { await expect(completeTopUp({store:a,vault:first},"test@example.com","mock-topup")).rejects.toMatchObject({status:503}); }
    finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='completed'`); }
    const restarted=connectStore();
    const result=await completeTopUp({store:restarted,vault:new MockVaultClient(restarted,id=>getMerchant(id)?.payTo)},"test@example.com","mock-topup");
    expect(result.status).toBe("completed");
    expect((await b.getPouch("mock-durable"))?.balance).toBe(10_000_005);
    expect(result.txSignature).toBe((await a.getOperation("topup:mock-topup"))?.txSignature);
  });
  it("rolls back a mock balance mutation if its journal cannot persist",async()=> {
    const p=await a.savePouch(fixturePouch("mock-rollback"));
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('journal')`);
    try { await expect(a.applyMockOperation({...p,balance:1},operation("mock-rollback","pay",p.id))).rejects.toThrow("injected real PostgreSQL"); }
    finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='journal'`); }
    expect((await b.getPouch(p.id))?.balance).toBe(p.balance);
    expect(await b.getOperation("mock-rollback")).toBeUndefined();
  });
  it("round-trips retailer metadata and payment completion time",async()=> {
    await a.savePouch(fixturePouch("metadata"));
    const order=await a.saveOrder({id:"metadata-order",pouchId:"metadata",merchantId:"web:fixture.example",request:"fixture",total:1,lines:[],status:"paid",createdAt:new Date().toISOString(),paidAt:new Date().toISOString(),store:{name:"Fixture",domain:"fixture.example"},fulfillment:{via:"instacart",label:"Instacart",checkoutUrl:"https://www.instacart.com/fixture",linkStatus:"ready"}});
    expect(await b.getOrder(order.id)).toEqual(order);
  });

  it("persists owner-scoped shopping lists and rejects racing writes and deletes across pools", async()=>{
    const now=new Date().toISOString();
    const list=await a.saveShoppingList({id:"weekly-list",ownerEmail:"test@example.com",name:"Week",items:[{name:"milk",qty:2}],createdAt:now,updatedAt:now});
    expect(await b.getShoppingList(list.id)).toEqual(list);
    expect(await b.listShoppingLists("another@example.com")).toEqual([]);
    await expect(b.saveShoppingList({...list,ownerEmail:"another@example.com"})).rejects.toBeInstanceOf(StoreConflictError);
    const results=await Promise.allSettled([a.saveShoppingList({...list,name:"First"}),b.saveShoppingList({...list,name:"Second"})]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    const changed=(await b.getShoppingList(list.id))!;
    await expect(b.deleteShoppingList(list.id,list.ownerEmail,list.version!)).rejects.toBeInstanceOf(StoreConflictError);
    await expect(b.deleteShoppingList(list.id,"another@example.com",changed.version!)).rejects.toBeInstanceOf(StoreConflictError);
    const reconnected=connectStore();
    expect(await reconnected.getShoppingList(list.id)).toEqual(changed);
    await reconnected.deleteShoppingList(list.id,list.ownerEmail,changed.version!);
    expect(await a.getShoppingList(list.id)).toBeUndefined();
    await expect(a.saveShoppingList(changed)).rejects.toBeInstanceOf(StoreConflictError);
  });

});
