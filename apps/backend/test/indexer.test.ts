import { describe, expect, it, vi } from "vitest";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { INDEXER_CURSOR, VaultIndexer, createEventDecoder, indexerDisabledReason, toRows, type IndexerConnection } from "../src/indexer.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import idlJson from "../src/vault/idl/solpouch_vault.json" with { type: "json" };
import { authHeaders, ownedSeed } from "./helpers.js";

// Fixtures only: no RPC, no database. Logs are built with the program IDL's BorshCoder.
const idl = idlJson as Idl;
const coder = new BorshCoder(idl);
const programId = new PublicKey(idlJson.address);
const pouchKey = Keypair.generate().publicKey;
const otherProgram = Keypair.generate().publicKey;
const thaiPayTo = new PublicKey(getMerchant("thai-express")!.payTo);
const ORDER = "0123456789abcdef0123456789abcdef";

function eventData(name: string, data: Record<string, unknown>): string {
  const disc = idlJson.events.find((e) => e.name === name)!.discriminator;
  return Buffer.concat([Buffer.from(disc), coder.types.encode(name, data)]).toString("base64");
}
const payment = (amount = 1_500_000, order = ORDER, time = 1_767_225_600) =>
  eventData("PaymentMade", { pouch: pouchKey, merchant: thaiPayTo, amount: new BN(amount), order_id: Array.from(Buffer.from(order, "hex")), time: new BN(time) });
const programLogs = (...data: string[]) => [
  `Program ${programId.toBase58()} invoke [1]`,
  "Program log: Instruction: Pay",
  ...data.map((d) => `Program data: ${d}`),
  `Program ${programId.toBase58()} success`,
];

describe("event decoding and row mapping", () => {
  const decode = createEventDecoder(programId, idl, () => {});
  const lookup = { pouchIdByAddress: new Map([[pouchKey.toBase58(), "uber-eats"]]), orderMerchant: async (id: string) => (id === ORDER ? "thai-express" : undefined) };

  it("maps PaymentMade to a payments row and every known event to an event row", async () => {
    const logs = programLogs(
      payment(),
      eventData("ToppedUp", { pouch: pouchKey, amount: new BN(5_000_000) }),
      eventData("Frozen", { pouch: pouchKey }),
      eventData("Unfrozen", { pouch: pouchKey }),
      eventData("Withdrawn", { pouch: pouchKey, amount: new BN(7) }),
    );
    const events = decode(logs);
    expect(events.map((e) => e.name)).toEqual(["PaymentMade", "ToppedUp", "Frozen", "Unfrozen", "Withdrawn"]);
    const rows = await toRows({ signature: "sig1", slot: 9, blockTime: 1_767_300_000 }, events, lookup, () => {});
    expect(rows.payments).toEqual([{ txSignature: "sig1", eventIndex: 0, time: "2026-01-01T00:00:00.000Z", pouchId: "uber-eats", merchantId: "thai-express", orderId: ORDER, amount: 1_500_000 }]);
    expect(rows.events.map((e) => [e.eventIndex, e.name, e.pouchAddress, e.amount])).toEqual([
      [0, "PaymentMade", pouchKey.toBase58(), 1_500_000],
      [1, "ToppedUp", pouchKey.toBase58(), 5_000_000],
      [2, "Frozen", pouchKey.toBase58(), null],
      [3, "Unfrozen", pouchKey.toBase58(), null],
      [4, "Withdrawn", pouchKey.toBase58(), 7],
    ]);
    expect(rows.events[1]!.time).toBe(new Date(1_767_300_000 * 1000).toISOString());
    expect(rows.events[0]!.data).toMatchObject({ merchant: thaiPayTo.toBase58(), amount: "1500000" });
  });

  it("falls back to the merchant wallet, then to the PDA, when the store has no match", async () => {
    const rows = await toRows({ signature: "s", slot: 1, blockTime: null }, decode(programLogs(payment(1, "f".repeat(32)))), { pouchIdByAddress: new Map(), orderMerchant: async () => undefined }, () => {});
    expect(rows.payments[0]).toMatchObject({ merchantId: "thai-express", pouchId: pouchKey.toBase58(), orderId: "f".repeat(32) });
  });

  it("ignores unknown events, other programs' data and malformed logs without crashing", async () => {
    const unknown = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), Buffer.alloc(32)]).toString("base64");
    const truncated = Buffer.from(idlJson.events.find((e) => e.name === "PaymentMade")!.discriminator).toString("base64");
    const logs = [
      ...programLogs(unknown, truncated, payment()),
      `Program ${otherProgram.toBase58()} invoke [1]`, `Program data: ${payment()}`, `Program ${otherProgram.toBase58()} success`,
    ];
    expect(decode(logs).map((e) => e.name)).toEqual(["PaymentMade"]);
    expect(decode(["Log truncated"])).toEqual([]);
    expect(decode([])).toEqual([]);
  });

  it("records events added to a newer IDL generically", async () => {
    const newer = structuredClone(idlJson) as typeof idlJson;
    newer.events.push({ name: "PouchClosed", discriminator: [9, 9, 9, 9, 9, 9, 9, 9] });
    newer.types.push({ name: "PouchClosed", type: { kind: "struct", fields: [{ name: "pouch", type: "pubkey" }] } } as never);
    const data = Buffer.concat([Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]), pouchKey.toBuffer()]).toString("base64");
    const log = vi.fn();
    const events = createEventDecoder(programId, newer as Idl, log)(programLogs(data));
    const rows = await toRows({ signature: "s", slot: 1, blockTime: 1 }, events, lookup, log);
    expect(rows.events).toMatchObject([{ name: "PouchClosed", pouchAddress: pouchKey.toBase58() }]);
    expect(rows.payments).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("PouchClosed"));
  });
});

/** Fake RPC: `chain` is oldest first; getSignaturesForAddress pages newest first like the real node. */
function fakeConnection(chain: { signature: string; logs: string[]; err?: boolean; missing?: boolean }[]) {
  let listener: ((logs: { err: unknown; logs: string[]; signature: string }) => void) | undefined;
  const fetched: string[] = [];
  const connection = {
    getSignaturesForAddress: vi.fn(async (_address: PublicKey, opts: { before?: string; until?: string; limit?: number } = {}) => {
      const newestFirst = [...chain].reverse();
      let start = opts.before ? newestFirst.findIndex((t) => t.signature === opts.before) + 1 : 0;
      const end = opts.until ? newestFirst.findIndex((t) => t.signature === opts.until) : newestFirst.length;
      if (start < 0) start = newestFirst.length;
      return newestFirst.slice(start, end < 0 ? newestFirst.length : end).slice(0, opts.limit ?? 1000).map((t, i): ConfirmedSignatureInfo => ({ signature: t.signature, slot: 100 + chain.indexOf(t), err: t.err ? { InstructionError: [0, { Custom: 1 }] } : null, memo: null, blockTime: 1_767_225_600 + i }));
    }),
    getTransaction: vi.fn(async (signature: string) => {
      fetched.push(signature);
      const t = chain.find((x) => x.signature === signature)!;
      if (t.missing) return null;
      return { slot: 100 + chain.indexOf(t), blockTime: 1_767_225_600, meta: { err: t.err ? {} : null, logMessages: t.logs } };
    }),
    onLogs: vi.fn((_id: PublicKey, cb: typeof listener) => { listener = cb; return 7; }),
    removeOnLogsListener: vi.fn(async () => {}),
  };
  return { connection: connection as unknown as IndexerConnection & typeof connection, fetched, emit: (sig: string) => listener?.({ err: null, logs: [], signature: sig }) };
}

describe("VaultIndexer backfill, cursor and idempotency", () => {
  const setup = (chain: Parameters<typeof fakeConnection>[0]) => {
    const store = new MemoryStore(ownedSeed().map((p) => (p.id === "uber-eats" ? { ...p, address: pouchKey.toBase58() } : p)));
    const rpc = fakeConnection(chain);
    const indexer = new VaultIndexer({ connection: rpc.connection, programId, store, pollMs: 60_000, log: () => {} });
    return { store, rpc, indexer };
  };

  it("backfills oldest first, skips failed transactions, and resumes from the cursor", async () => {
    const chain = [
      { signature: "a", logs: programLogs(payment(1_000_000, "a".repeat(32))) },
      { signature: "b", logs: programLogs(payment(2_000_000, "b".repeat(32))), err: true },
      { signature: "c", logs: programLogs(payment(3_000_000, "c".repeat(32))) },
    ];
    const { store, rpc, indexer } = setup(chain);
    expect(await indexer.sync()).toBe(2);
    expect(rpc.fetched).toEqual(["a", "c"]);
    expect(await store.getIndexerCursor(INDEXER_CURSOR)).toEqual({ signature: "c", slot: 102 });
    chain.push({ signature: "d", logs: programLogs(payment(4_000_000, "d".repeat(32))) });
    expect(await indexer.sync()).toBe(1);
    expect(rpc.fetched).toEqual(["a", "c", "d"]);
    expect(rpc.connection.getSignaturesForAddress).toHaveBeenLastCalledWith(programId, { limit: 1000, until: "c" }, "confirmed");
    expect((await store.indexedSpend(["uber-eats"], "day"))!.reduce((s, p) => s + p.spent, 0)).toBe(8_000_000);
  });

  it("is idempotent when the same transactions are processed again", async () => {
    const chain = [{ signature: "a", logs: programLogs(payment()) }];
    const { store, indexer } = setup(chain);
    await indexer.sync();
    await store.saveIndexerCursor(INDEXER_CURSOR, { signature: "", slot: 0 }); // force a replay
    const replay = new VaultIndexer({ connection: fakeConnection(chain).connection, programId, store, log: () => {} });
    expect(await replay.sync()).toBe(0);
    expect(await store.indexedSpend(["uber-eats"], "day")).toEqual([{ bucket: "2026-01-01T00:00:00.000Z", pouchId: "uber-eats", spent: 1_500_000, orders: 1 }]);
  });

  it("does not advance the cursor past a transaction the RPC cannot serve yet", async () => {
    const chain = [
      { signature: "a", logs: programLogs(payment(1, "a".repeat(32))) },
      { signature: "b", logs: programLogs(payment(2, "b".repeat(32))), missing: true },
    ];
    const { store, indexer } = setup(chain);
    await expect(indexer.sync()).rejects.toThrow("not available yet");
    expect((await store.getIndexerCursor(INDEXER_CURSOR))!.signature).toBe("a");
    chain[1]!.missing = false;
    expect(await indexer.sync()).toBe(1);
  });

  it("pages through more than one signature page", async () => {
    const chain = Array.from({ length: 1001 }, (_, i) => ({ signature: `s${i}`, logs: programLogs(payment(1, i.toString(16).padStart(32, "0"))) }));
    const { store, rpc, indexer } = setup(chain);
    expect(await indexer.sync()).toBe(1001);
    expect(rpc.connection.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(rpc.fetched[0]).toBe("s0");
    expect((await store.getIndexerCursor(INDEXER_CURSOR))!.signature).toBe("s1000");
  });

  it("subscribes to program logs, syncs on a notification, and unsubscribes on stop", async () => {
    const chain = [{ signature: "a", logs: programLogs(payment()) }];
    const { store, rpc, indexer } = setup(chain);
    await indexer.start();
    expect(rpc.connection.onLogs).toHaveBeenCalledWith(programId, expect.any(Function), "confirmed");
    chain.push({ signature: "b", logs: programLogs(payment(5, "b".repeat(32))) });
    rpc.emit("b");
    await vi.waitFor(async () => expect((await store.getIndexerCursor(INDEXER_CURSOR))!.signature).toBe("b"));
    await indexer.stop();
    expect(rpc.connection.removeOnLogsListener).toHaveBeenCalledWith(7);
  });
});

describe("indexer gating", () => {
  it("is off by default and requires chain mode, Postgres and a program ID", () => {
    const env = { ENABLE_INDEXER: "true", VAULT_MODE: "chain", VAULT_PROGRAM_ID: programId.toBase58() };
    expect(indexerDisabledReason({}, true)).toMatch(/ENABLE_INDEXER/);
    expect(indexerDisabledReason({ ...env, VAULT_MODE: "mock" }, true)).toMatch(/VAULT_MODE/);
    expect(indexerDisabledReason(env, false)).toMatch(/Postgres/);
    expect(indexerDisabledReason({ ...env, VAULT_PROGRAM_ID: "" }, true)).toMatch(/VAULT_PROGRAM_ID/);
    expect(indexerDisabledReason(env, true)).toBeUndefined();
  });
});

describe("/stats/spend with indexed payments", () => {
  it("uses indexed payments plus not-yet-indexed paid orders, scoped to the account", async () => {
    const store = new MemoryStore([...ownedSeed(), { ...ownedSeed()[0]!, id: "other-pouch", address: "other", ownerEmail: "other@example.com" }]);
    const app = createApp({ store, vault: new MockVaultClient(store, () => undefined) });
    const headers = await authHeaders(store);
    await store.saveOrder({ id: "paid-order", pouchId: "uber-eats", merchantId: "thai-express", request: "x", lines: [], total: 100, status: "paid", createdAt: "2026-01-03T01:00:00.000Z", paidAt: "2026-01-03T01:00:00.000Z" });
    const fallback = await (await app.request("/stats/spend?bucket=day", { headers })).json();
    expect(fallback).toEqual([{ pouchId: "uber-eats", bucket: "2026-01-03T00:00:00.000Z", spent: 100, orders: 1 }]);

    const ev = (signature: string, pouchId: string) => ({
      events: [{ signature, eventIndex: 0, name: "PaymentMade", pouchAddress: null, amount: 250, time: "2026-01-05T10:30:00.000Z", slot: 1, data: {} }],
      payments: [{ txSignature: signature, eventIndex: 0, time: "2026-01-05T10:30:00.000Z", pouchId, merchantId: null, orderId: "0".repeat(32), amount: 250 }],
    });
    for (const [sig, pouch] of [["x1", "uber-eats"], ["x2", "other-pouch"]] as const) { const r = ev(sig, pouch); await store.recordVaultEvents(r.events, r.payments); }
    // "paid-order" has no indexed payment yet, so it still counts; other-pouch's payment does not.
    expect(await (await app.request("/stats/spend?bucket=hour", { headers })).json()).toEqual([
      { pouchId: "uber-eats", bucket: "2026-01-03T01:00:00.000Z", spent: 100, orders: 1 },
      { pouchId: "uber-eats", bucket: "2026-01-05T10:00:00.000Z", spent: 250, orders: 1 },
    ]);
    expect(await (await app.request("/stats/spend?bucket=day&pouchId=groceries", { headers })).json()).toEqual([]);
    expect((await app.request("/stats/spend?pouchId=other-pouch", { headers })).status).toBe(404);
  });

  it("counts a paid order once: from the order while the indexer lags, then from its indexed payment", async () => {
    const store = new MemoryStore(ownedSeed());
    const app = createApp({ store, vault: new MockVaultClient(store, () => undefined) });
    const headers = await authHeaders(store);
    const paid = (id: string, total: number, at: string) => store.saveOrder({ id, pouchId: "uber-eats", merchantId: "thai-express", request: "x", lines: [], total, status: "paid", createdAt: at, paidAt: at });
    const a = "a".repeat(32), b = "b".repeat(32);
    await paid(a, 300, "2026-02-01T09:00:00.000Z");
    await paid(b, 700, "2026-02-01T15:00:00.000Z");
    // Only order a is indexed (orderId hex = orders.id); b is still waiting for the indexer.
    await store.recordVaultEvents(
      [{ signature: "s-a", eventIndex: 0, name: "PaymentMade", pouchAddress: null, amount: 300, time: "2026-02-01T09:00:05.000Z", slot: 1, data: {} }],
      [{ txSignature: "s-a", eventIndex: 0, time: "2026-02-01T09:00:05.000Z", pouchId: "uber-eats", merchantId: null, orderId: a.toUpperCase(), amount: 300 }],
    );
    expect(await (await app.request("/stats/spend?bucket=day", { headers })).json()).toEqual([
      { pouchId: "uber-eats", bucket: "2026-02-01T00:00:00.000Z", spent: 1000, orders: 2 },
    ]);
    await store.recordVaultEvents(
      [{ signature: "s-b", eventIndex: 0, name: "PaymentMade", pouchAddress: null, amount: 700, time: "2026-02-01T15:00:05.000Z", slot: 2, data: {} }],
      [{ txSignature: "s-b", eventIndex: 0, time: "2026-02-01T15:00:05.000Z", pouchId: "uber-eats", merchantId: null, orderId: b, amount: 700 }],
    );
    expect(await (await app.request("/stats/spend?bucket=day&pouchId=uber-eats", { headers })).json()).toEqual([
      { pouchId: "uber-eats", bucket: "2026-02-01T00:00:00.000Z", spent: 1000, orders: 2 },
    ]);
  });
});
