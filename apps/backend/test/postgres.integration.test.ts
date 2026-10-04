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
const fixturePouch = (id: string): Pouch => ({ id, address: `addr-${id}`, name: "Integration test", balance: 10_000_000, maxPerOrder: 5_000_000, dailyLimit: 10_000_000, spentToday: 0, confirmAbove: 0, allowedMerchantIds: ["thai-express"], frozen: false, ownerWallet: "test-owner" });
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

  it("consumes an authentication challenge exactly once across pools and persists sessions", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await a.saveChallenge({ id: "nonce", wallet: "owner", message: "fixture signed message", expiresAt });
    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).consumeChallenge("nonce")));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await a.saveSession({ tokenHash: "hashed-session", wallet: "owner", expiresAt });
    expect((await b.getSession("hashed-session"))?.wallet).toBe("owner");
    await b.deleteSession("hashed-session");
    expect(await a.getSession("hashed-session")).toBeUndefined();
    await a.saveChallenge({ id: "expired", wallet: "owner", message: "old", expiresAt: new Date(0).toISOString() });
    expect(await b.consumeChallenge("expired")).toBeUndefined();
  });

  it("enforces a shared atomic rate limit across pools", async () => {
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).consumeRateLimit("shared-bucket", 60_000, 7)));
    expect(results.filter(r => r.allowed)).toHaveLength(7);
    expect(results.every(r => r.retryAfter > 0)).toBe(true);
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
    await a.saveOrder({ id: "order", pouchId: "payment", merchantId: "thai-express", request: "fixture", total: 5, lines: [], status: "draft", createdAt: new Date().toISOString() });
    const rpc = rpcFixture();
    await admin.query(`INSERT INTO ${schema}.failure_fixture VALUES ('paid')`);
    try {
      await expect(confirmOrder({ store: a, vault: fixtureVault(a, rpc) }, "order")).rejects.toThrow("injected real PostgreSQL");
      expect((await b.getOrder("order"))?.status).toBe("paying");
    } finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='paid'`); }
    const restarted = connectStore();
    const results = await Promise.all([confirmOrder({ store: restarted, vault: fixtureVault(restarted, rpc) }, "order"), confirmOrder({ store: b, vault: fixtureVault(b, rpc) }, "order")]);
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
      await expect(completeTopUp({ store: a, vault: fixtureVault(a, rpc) }, "topup")).rejects.toMatchObject({ status: 503 });
      expect((await b.getTopUp("topup"))?.status).toBe("processing");
    } finally { await admin.query(`DELETE FROM ${schema}.failure_fixture WHERE kind='completed'`); }
    const restarted = connectStore();
    const results = await Promise.all([completeTopUp({ store: restarted, vault: fixtureVault(restarted, rpc) }, "topup"), completeTopUp({ store: b, vault: fixtureVault(b, rpc) }, "topup")]);
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
    await expect(completeTopUp({ store: a, vault: fixtureVault(a, before) }, "restart-topup")).rejects.toMatchObject({ status: 503 });
    const savedJournal = await b.getOperation("topup:restart-topup");
    expect(savedJournal).toBeDefined();
    expect((await b.getTopUp("restart-topup"))?.status).toBe("processing");
    const beforeRestart = await admin.query("SELECT pg_postmaster_start_time() AS started");
    await Promise.all(stores.splice(0).map(store => store.close()));
    await admin.end();
    try {
      execFileSync(restartBinary!, ["-D", restartDataDir!, "-l", join(restartDataDir!, "integration-restart.log"), "-m", "fast", "-w", "restart"], { timeout: 15_000, stdio: "ignore" });
    } finally { admin = new pg.Pool(postgresPoolConfig(url!)); }
    const afterRestart = await admin.query("SELECT pg_postmaster_start_time() AS started");
    expect(afterRestart.rows[0].started.getTime()).toBeGreaterThan(beforeRestart.rows[0].started.getTime());
    a = connectStore(); b = connectStore();
    expect(await b.getOperation("topup:restart-topup")).toEqual(savedJournal);
    const after = rpcFixture();
    after.status = vi.fn(async () => ({ confirmed: true, failed: false }));
    const recovered = await completeTopUp({ store: a, vault: fixtureVault(a, after) }, "restart-topup");
    expect(recovered.status).toBe("completed");
    expect(recovered.txSignature).toBe(savedJournal!.txSignature);
    expect(before.broadcast).toHaveBeenCalledTimes(1);
    expect(after.broadcast).not.toHaveBeenCalled();
  }, 20_000);

});
