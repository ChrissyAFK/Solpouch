import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order, TopUp } from "@solpouch/shared";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { PostgresStore, postgresPoolConfig } from "../src/store/postgres.js";
import { StoreConflictError, type VaultOperation } from "../src/store/types.js";
import type pg from "pg";

function postgresFixture(pool: object) {
  return new (PostgresStore as unknown as new (p: pg.Pool) => PostgresStore)(Object.assign(new EventEmitter(), pool) as unknown as pg.Pool);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const pouch = () => ({ ...seedPouches()[0], ownerWallet: "wallet-a" });
const operation = (): VaultOperation => ({ id: "op", kind: "topup", pouchId: "p", txSignature: "signature", signedTransaction: "signed-bytes", lastValidBlockHeight: 42, createdAt: "2026-10-03T00:00:00.000Z" });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe("MemoryStore isolation and versions", () => {
  it("starts empty unless fixtures are explicit and detaches all pouch reads/writes", async () => {
    const store = new MemoryStore();
    expect(await store.listPouches()).toEqual([]);
    const input = pouch();
    const saved = await store.savePouch(input);
    expect(saved.version).toBe(1);
    saved.allowedMerchantIds.push("tampered"); input.name = "tampered";
    const listed = await store.listPouches(); listed[0].name = "tampered-again";
    expect((await store.getPouch(input.id))?.name).toBe("Uber Eats");
    expect((await store.getPouch(input.id))?.allowedMerchantIds).toEqual(["thai-express"]);
  });

  it("rejects stale, missing, and invented versions instead of losing updates", async () => {
    const store = new MemoryStore([pouch()]);
    const a = (await store.getPouch("uber-eats"))!;
    const b = (await store.getPouch("uber-eats"))!;
    expect(a.version).toBe(0);
    expect((await store.savePouch({ ...a, frozen: true })).version).toBe(1);
    await expect(store.savePouch({ ...b, balance: 0 })).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.savePouch({ ...a, version: undefined })).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.savePouch({ ...a, id: "missing", version: 9 })).rejects.toBeInstanceOf(StoreConflictError);
    expect((await store.getPouch(a.id))?.frozen).toBe(true);
  });

  it("versions and detaches orders and topups", async () => {
    const store = new MemoryStore();
    const order: Order = { id: "o", pouchId: "p", merchantId: "m", request: "milk", lines: [], total: 1, status: "draft", createdAt: new Date().toISOString() };
    const first = await store.saveOrder(order);
    const next = await store.saveOrder({ ...first, status: "paying" });
    expect(next.version).toBe(2);
    next.status = "paid";
    expect((await store.getOrder("o"))?.status).toBe("paying");
    await expect(store.saveOrder(first)).rejects.toBeInstanceOf(StoreConflictError);
    const topup: TopUp = { id: "t", pouchId: "p", amount: 1, reason: "test", status: "cooling_down", readyAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    const top = await store.saveTopUp(topup);
    expect((await store.saveTopUp({ ...top, status: "processing", txSignature: "tx" })).version).toBe(2);
    await expect(store.saveTopUp(top)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it("serializes one pouch, allows unrelated pouches, and releases after failure", async () => {
    const store = new MemoryStore(); const entered = deferred(); const finish = deferred(); const events: string[] = [];
    const first = store.withPouchLock("a", async () => { events.push("a1"); entered.resolve(); await finish.promise; throw new Error("failure"); });
    const caught = first.catch(() => events.push("failed"));
    await entered.promise;
    const second = store.withPouchLock("a", async () => { events.push("a2"); });
    await store.withPouchLock("b", async () => { events.push("b"); });
    expect(events).toEqual(["a1", "b"]);
    finish.resolve(); await Promise.all([caught, second]);
    expect(events).toContain("a2");
    await store.withPouchLock("a", () => store.withPouchLock("a", async () => events.push("nested")));
    expect(events).toContain("nested");
  });
});

describe("journal and authentication persistence", () => {
  it("allows identical journal replay, rejects replacement, and detaches reads", async () => {
    const store = new MemoryStore(); const op = operation();
    await store.saveOperation(op); await store.saveOperation({ ...op });
    const read = (await store.getOperation("op"))!; read.txSignature = "changed";
    await expect(store.saveOperation({ ...op, signedTransaction: "different" })).rejects.toBeInstanceOf(StoreConflictError);
    expect(await store.getOperation("op")).toEqual(op);
  });
  it("consumes challenges exactly once under concurrency and discards expired ones", async () => {
    const store = new MemoryStore();
    await store.saveChallenge({ id: "c", wallet: "w", message: "m", expiresAt: new Date(Date.now() + 60000).toISOString() });
    const results = await Promise.all([store.consumeChallenge("c"), store.consumeChallenge("c")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await store.saveChallenge({ id: "old", wallet: "w", message: "m", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await store.consumeChallenge("old")).toBeUndefined();
  });
  it("keeps session scope, expires and revokes sessions", async () => {
    const store = new MemoryStore();
    const session = { tokenHash: "hash", wallet: "wallet", expiresAt: new Date(Date.now() + 60000).toISOString(), scope: "voice" as const, parentTokenHash: "web-parent" };
    await store.saveSession(session);
    expect((await store.getSession("hash"))?.scope).toBe("voice");
    expect((await store.getSession("hash"))?.parentTokenHash).toBe("web-parent");
    await expect(store.saveSession({ ...session, wallet: "other" })).rejects.toBeInstanceOf(StoreConflictError);
    await store.deleteSession("hash"); expect(await store.getSession("hash")).toBeUndefined();
    await store.saveSession({ ...session, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await store.getSession("hash")).toBeUndefined();
  });
  it("cleans expired memory records periodically across auth and rate buckets", async () => {
    vi.useFakeTimers(); const store = new MemoryStore();
    const expiry = new Date(Date.now() + 1000).toISOString();
    await store.saveChallenge({ id: "old", wallet: "w", message: "m", expiresAt: expiry });
    await store.saveSession({ tokenHash: "old", wallet: "w", expiresAt: expiry });
    await store.consumeRateLimit("old", 1000, 1);
    vi.advanceTimersByTime(60_001);
    await store.consumeRateLimit("fresh", 1000, 1);
    const internal = store as unknown as { challenges: Map<string, unknown>; sessions: Map<string, unknown>; rateLimits: Map<string, unknown> };
    expect(internal.challenges.has("old")).toBe(false);
    expect(internal.sessions.has("old")).toBe(false);
    expect(internal.rateLimits.has("old")).toBe(false);
  });
  it("counts concurrent rate attempts atomically and resets after the window", async () => {
    vi.useFakeTimers(); const store = new MemoryStore();
    const attempts = await Promise.all(Array.from({ length: 10 }, () => store.consumeRateLimit("key", 5000, 3)));
    expect(attempts.filter((r) => r.allowed)).toHaveLength(3);
    expect(attempts[9].retryAfter).toBe(5);
    vi.advanceTimersByTime(5000);
    expect((await store.consumeRateLimit("key", 5000, 3)).allowed).toBe(true);
  });
});

describe("Postgres boundary checks (mocked connections; no live database)", () => {
  it("verifies remote TLS despite URL SSL overrides and rejects remote disable", () => {
    vi.stubEnv("DATABASE_CA_CERT", ""); vi.stubEnv("DB_ALLOW_INSECURE_LOCAL", "true");
    const config = postgresPoolConfig("postgres://u:p@db.example.test/db?sslmode=no-verify&ssl=false");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain("ssl");
    expect(() => postgresPoolConfig("postgres://u:p@db.example.test/db?sslmode=disable")).toThrow("localhost");
    expect(postgresPoolConfig("postgres://u:p@localhost/db?sslmode=disable").ssl).toBe(false);
  });
  it("reuses a locked connection for nested store calls and releases on errors", async () => {
    const calls: string[] = [];
    const client = Object.assign(new EventEmitter(), { query: vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; }), release: vi.fn() });
    const pool = { connect: vi.fn(async () => client), query: vi.fn() };
    const store = postgresFixture(pool);
    await expect(store.withPouchLock("p", async () => { await store.listPouches(); await store.withPouchLock("p", async () => {}); throw new Error("work failed"); })).rejects.toThrow("work failed");
    expect(pool.connect).toHaveBeenCalledTimes(1); expect(pool.query).not.toHaveBeenCalled();
    expect(calls[0]).toContain("pg_advisory_lock"); expect(calls.at(-1)).toContain("pg_advisory_unlock");
    expect(client.release).toHaveBeenCalledWith(false);
  });
  it("destroys a pooled connection if unlocking fails", async () => {
    const client = Object.assign(new EventEmitter(), { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("connection lost")), release: vi.fn() });
    const pool = { connect: vi.fn(async () => client) };
    const store = postgresFixture(pool);
    await expect(store.withPouchLock("p", async () => 1)).rejects.toThrow("connection lost");
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it("persists the voice parent and bounds PostgreSQL cleanup to once per minute", async () => {
    vi.useFakeTimers();
    const expiry = new Date(Date.now() + 120_000).toISOString();
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rowCount: 1, rows: sql.startsWith("SELECT") ? [{ token_hash: "voice", wallet: "w", expires_at: expiry, scope: "voice", parent_token_hash: "parent" }] : [] }));
    const store = postgresFixture({ query });
    await store.saveSession({ tokenHash: "voice", wallet: "w", expiresAt: expiry, scope: "voice", parentTokenHash: "parent" });
    expect((await store.getSession("voice"))?.parentTokenHash).toBe("parent");
    expect(query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))?.[1]?.at(-1)).toBe("parent");
    await store.saveChallenge({ id: "c", wallet: "w", message: "m", expiresAt: expiry });
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("DELETE"))).toHaveLength(3);
    vi.advanceTimersByTime(60_001);
    await store.saveChallenge({ id: "d", wallet: "w", message: "m", expiresAt: expiry });
    const cleanup = query.mock.calls.filter(([sql]) => sql.startsWith("DELETE"));
    expect(cleanup).toHaveLength(6);
    for (const [sql] of cleanup) expect(sql).toContain("LIMIT 1000) AND expires_at <= now()");
  });
  it("handles idle pool error events without logging provider details", () => {
    const pool = new EventEmitter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new (PostgresStore as unknown as new (p: pg.Pool) => PostgresStore)(pool as unknown as pg.Pool);
    expect(() => pool.emit("error", new Error("private connection details"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Database connection closed unexpectedly; the pool will replace it.");
    warn.mockRestore();
  });
  it("marks a disconnected lock context failed and blocks all later nested queries", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
    const store = postgresFixture({ connect: async () => client });
    await expect(store.withPouchLock("p", async () => {
      expect(() => client.emit("error", new Error("socket reset"))).not.toThrow();
      await expect(store.listPouches()).rejects.toThrow("connection lost");
      await expect(store.withPouchLock("nested", async () => {})).rejects.toThrow("connection lost");
      return "ignored success";
    })).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it("rejects stale PostgreSQL versions before issuing a write", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT *") ? [{ version: 3 }] : [] }));
    const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
    const pool = { connect: vi.fn(async () => client) };
    const store = postgresFixture(pool);
    await expect(store.savePouch({ ...pouch(), version: 2 })).rejects.toBeInstanceOf(StoreConflictError);
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
    expect(client.release).toHaveBeenCalledWith(false);
  });
  it("uses a compare-and-swap predicate and surfaces a failed PostgreSQL update", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith("SELECT *") ? [{ version: 3 }] : [] }));
    const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
    const pool = { connect: vi.fn(async () => client) };
    const store = postgresFixture(pool);
    await expect(store.savePouch({ ...pouch(), version: 3 })).rejects.toBeInstanceOf(StoreConflictError);
    const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))!;
    expect(update[0]).toMatch(/WHERE id=\$1 AND version=\$\d+ RETURNING/);
    expect(update[1]?.at(-1)).toBe(3);
    expect(query.mock.calls.some(([sql]) => /BEGIN|COMMIT/.test(sql))).toBe(false);
  });
  it("does not reset stored spending based on the server date", async () => {
    const row = { id: "p", name: "P", address: "a", balance: "10", max_per_order: "20", daily_limit: "30", spent_today: "9", spent_day: new Date("2000-01-01"), confirm_above: "0", allowed_merchant_ids: [], frozen: false, version: "0" };
    const pool = { query: vi.fn(async () => ({ rows: [row] })) };
    const store = postgresFixture(pool);
    expect((await store.getPouch("p"))?.spentToday).toBe(9);
  });
});
