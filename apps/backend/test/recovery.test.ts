import { BN } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order } from "@solpouch/shared";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { SyncedVaultClient } from "../src/vault/synced.js";
import { getMerchant } from "../src/merchants/index.js";
import { confirmOrder } from "../src/services/orders.js";
import { completeTopUp } from "../src/services/topups.js";
import { recoverTransaction, type RecoveryTransport } from "../src/vault/recovery.js";
import type { VaultOperation } from "../src/store/types.js";
import { ensureOnChain, ChainVaultClient, programRejection } from "../src/vault/chain.js";
import { cancelOrder } from "../src/services/orders.js";
import { VaultRejected } from "../src/vault/types.js";

vi.mock("@solana/spl-token", async (importOriginal) => ({
  ...await importOriginal<typeof import("@solana/spl-token")>(),
  getAccount: vi.fn(),
}));

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  store = new MemoryStore(seedPouches());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
const operation: VaultOperation = { id: "pay:one", kind: "pay", pouchId: "uber-eats", txSignature: "signature", signedTransaction: Buffer.from("signed bytes").toString("base64"), lastValidBlockHeight: 100, createdAt: "2026-10-03T00:00:00Z" };
function transport(): RecoveryTransport {
  return { status: vi.fn().mockResolvedValue({ confirmed: false, failed: false }), blockHeight: vi.fn().mockResolvedValue(50), broadcast: vi.fn().mockResolvedValue("signature"), confirm: vi.fn().mockResolvedValue({ failed: false }) };
}
async function draft() {
  return store.saveOrder({ id: "one", pouchId: "uber-eats", merchantId: "thai-express", request: "test", lines: [], total: toMicros(5), status: "draft", createdAt: new Date().toISOString() } as Order);
}

describe("durable signed transaction recovery", () => {
  it("recovers from a serialized journal with a recreated store and RPC client", async () => {
    const before = transport();
    before.broadcast = vi.fn().mockRejectedValue(new Error("process lost after broadcast"));
    await expect(recoverTransaction(store, operation.id, before, async () => operation, operation)).rejects.toThrow("not confirmed");
    // Explicit restart fixture: carry only the durable record into a fresh store/client.
    const persisted = JSON.stringify(await store.getOperation(operation.id));
    const restartedStore = new MemoryStore([]);
    await restartedStore.saveOperation(JSON.parse(persisted));
    const after = transport();
    after.status = vi.fn().mockResolvedValue({ confirmed: true, failed: false });
    const prepare = vi.fn();
    expect(await recoverTransaction(restartedStore, operation.id, after, prepare, operation)).toEqual({ txSignature: operation.txSignature });
    expect(prepare).not.toHaveBeenCalled();
    expect(after.broadcast).not.toHaveBeenCalled();
  });
  it("rejects journal records belonging to a different pouch before any RPC", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), { kind: "pay", pouchId: "another" })).rejects.toThrow("context");
    expect(rpc.status).not.toHaveBeenCalled();
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
  it("rejects non-devnet signing before preparing or recording a top-up", async () => {
    const fake = Object.assign(Object.create(ChainVaultClient.prototype), {
      connection: { getGenesisHash: vi.fn().mockResolvedValue("mainnet") },
      owner: Keypair.generate(), mint: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey, store,
    }) as ChainVaultClient;
    const save = vi.spyOn(store, "saveOperation");
    await expect(fake.topUp("uber-eats", 1, "topup")).rejects.toThrow("restricted to Solana devnet");
    expect(save).not.toHaveBeenCalled();
  });

  it("accepts the complete official devnet genesis hash for journal recovery", async () => {
    // solana-labs/solana sdk/src/genesis_config.rs; confirmed against public devnet RPC.
    const entry = { ...operation, id: "topup:devnet-check", kind: "topup" as const };
    await store.saveOperation(entry);
    const fake = Object.assign(Object.create(ChainVaultClient.prototype), {
      connection: {
        getGenesisHash: vi.fn().mockResolvedValue("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
        getSignatureStatuses: vi.fn().mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      },
      owner: Keypair.generate(), mint: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey, store,
    }) as ChainVaultClient;
    await expect(fake.topUp(entry.pouchId, 1, "devnet-check")).resolves.toEqual({ txSignature: entry.txSignature });
  });

  it("persists before broadcast and reuses identical bytes after a lost response", async () => {
    const rpc = transport();
    const prepare = vi.fn().mockResolvedValue(operation);
    rpc.broadcast = vi.fn(async () => {
      expect(await store.getOperation(operation.id)).toEqual(operation);
      throw new Error("lost RPC response");
    });
    await expect(recoverTransaction(store, operation.id, rpc, prepare, operation)).rejects.toThrow("not confirmed");
    rpc.broadcast = vi.fn().mockResolvedValue("signature");
    await expect(recoverTransaction(store, operation.id, rpc, prepare, operation)).resolves.toEqual({ txSignature: "signature" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(Buffer.from(vi.mocked(rpc.broadcast).mock.calls[0][0]).toString()).toBe("signed bytes");
  });
  it("returns already confirmed signatures without broadcasting or rebuilding", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.status = vi.fn().mockResolvedValue({ confirmed: true, failed: false });
    const prepare = vi.fn();
    expect(await recoverTransaction(store, operation.id, rpc, prepare, operation)).toEqual({ txSignature: "signature" });
    expect(rpc.broadcast).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
  it("does not broadcast if journal persistence fails", async () => {
    vi.spyOn(store, "saveOperation").mockRejectedValue(new Error("database offline"));
    const rpc = transport();
    await expect(recoverTransaction(store, operation.id, rpc, async () => operation, operation)).rejects.toThrow("database offline");
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
  it("never replaces an expired uncertain transaction", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.blockHeight = vi.fn().mockResolvedValue(101);
    const prepare = vi.fn();
    await expect(recoverTransaction(store, operation.id, rpc, prepare, operation)).rejects.toThrow("expired");
    expect(prepare).not.toHaveBeenCalled();
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
  it("does not treat a failed chain transaction as paid", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: true });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toMatchObject({ code: "TxFailed" });
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
  it("rejects terminally only when expiry is proven by a missing signature status", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.blockHeight = vi.fn().mockResolvedValue(101);
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, found: false });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toMatchObject({ code: "TxExpired" });
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, found: true });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toThrow("expired");
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
});

describe("payment service recovery", () => {
  it("reads chain rules and rejects unrecognized merchant addresses", async () => {
    const owner = Keypair.generate();
    const mint = Keypair.generate().publicKey;
    const account = { owner: owner.publicKey, mint, dayStart: new BN(Math.floor(Date.now() / 1000)),
      spentToday: new BN(2), frozen: true, maxPerOrder: new BN(3), dailyLimit: new BN(4),
      allowedMerchants: [new PublicKey(getMerchant("thai-express")!.payTo)] };
    vi.mocked(getAccount).mockResolvedValue({ amount: 10n } as Awaited<ReturnType<typeof getAccount>>);
    const fake = Object.assign(Object.create(ChainVaultClient.prototype), {
      connection: {}, owner, mint, programId: Keypair.generate().publicKey,
      payToOf: (id: string) => getMerchant(id)?.payTo,
      program: { account: { pouch: { fetch: vi.fn().mockResolvedValue(account) } } },
    }) as ChainVaultClient;
    expect(await fake.getState("uber-eats")).toEqual({ balance: 10, spentToday: 2, spentSince: new Date(account.dayStart.toNumber() * 1000).toISOString(), frozen: true, maxPerOrder: 3, dailyLimit: 4, allowedMerchantIds: ["thai-express"] });
    // An unknown key is skipped with a warning instead of breaking the listing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    account.allowedMerchants = [Keypair.generate().publicKey];
    expect((await fake.getState("uber-eats")).allowedMerchantIds).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("serializes simultaneous confirmations and returns the same paid outcome", async () => {
    await draft();
    const results = await Promise.all([confirmOrder({ store, vault }, "one"), confirmOrder({ store, vault }, "one")]);
    expect(results[0].txSignature).toBe(results[1].txSignature);
    expect((await store.getPouch("uber-eats"))!.balance).toBe(toMicros(95));
  });
  it("recovers after paid state save fails, including a recreated mock client", async () => {
    await draft();
    const original = store.saveOrder.bind(store);
    let fail = true;
    vi.spyOn(store, "saveOrder").mockImplementation(async (order) => {
      if (order.status === "paid" && fail) { fail = false; throw new Error("database disconnected"); }
      return original(order);
    });
    await expect(confirmOrder({ store, vault }, "one")).rejects.toThrow("database disconnected");
    expect((await store.getOrder("one"))!.status).toBe("paying");
    const restarted = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
    expect((await confirmOrder({ store, vault: restarted }, "one")).status).toBe("paid");
    expect((await store.getPouch("uber-eats"))!.balance).toBe(toMicros(95));
  });
  it("keeps uncertain payments paying instead of allowing a new draft", async () => {
    await draft();
    // A journal entry means a transaction may have been sent, so the order must stay paying.
    await store.saveOperation({ id: "pay:one", kind: "pay", pouchId: "uber-eats", txSignature: "sig", signedTransaction: "tx", lastValidBlockHeight: 1, createdAt: new Date().toISOString() });
    vi.spyOn(vault, "pay").mockRejectedValue(new Error("timeout"));
    await expect(confirmOrder({ store, vault }, "one")).rejects.toMatchObject({ status: 503 });
    expect((await store.getOrder("one"))!.status).toBe("paying");
  });
  it("returns confirmed payment when chain cache refresh fails", async () => {
    vi.spyOn(vault, "getBalance").mockRejectedValue(new Error("RPC unavailable"));
    const synced = new SyncedVaultClient(vault, store);
    const result = await synced.pay((await store.getPouch("uber-eats"))!, getMerchant("thai-express")!.payTo, toMicros(5), "one");
    expect(result.txSignature).toBeTruthy();
  });
  it("keeps top-up processing when the external outcome is unknown", async () => {
    await store.saveTopUp({ id: "topup", pouchId: "uber-eats", amount: toMicros(5), reason: "more food", status: "cooling_down", readyAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString() });
    vi.spyOn(vault, "topUp").mockImplementation(async () => {
      expect((await store.getTopUp("topup"))!.status).toBe("processing");
      throw new Error("RPC disconnected");
    });
    await expect(completeTopUp({ store, vault }, "topup")).rejects.toMatchObject({ status: 503 });
    expect((await store.getTopUp("topup"))!.status).toBe("processing");
  });
  it("retries top-up state persistence without depositing twice", async () => {
    await store.saveTopUp({ id: "topup", pouchId: "uber-eats", amount: toMicros(5), reason: "more food", status: "cooling_down", readyAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString() });
    const original = store.saveTopUp.bind(store);
    let fail = true;
    vi.spyOn(store, "saveTopUp").mockImplementation(async (topup) => {
      if (topup.status === "completed" && fail) { fail = false; throw new Error("save failed"); }
      return original(topup);
    });
    await expect(completeTopUp({ store, vault }, "topup")).rejects.toMatchObject({ status: 503 });
    expect((await store.getTopUp("topup"))!.status).toBe("processing");
    const results = await Promise.all([completeTopUp({ store, vault }, "topup"), completeTopUp({ store, vault }, "topup")]);
    expect(results.every(t => t.status === "completed")).toBe(true);
    expect(results[0].txSignature).toBeTruthy();
    expect(results[1].txSignature).toBe(results[0].txSignature);
    expect((await store.getPouch("uber-eats"))!.balance).toBe(toMicros(105));
  });
  it("startup only reads chain state and never creates or funds missing accounts", async () => {
    const getBalance = vi.fn().mockResolvedValue({ balance: 0, spentToday: 0 });
    const createPouch = vi.fn();
    const topUp = vi.fn();
    const fake = { getState: getBalance, createPouch, topUp } as unknown as ChainVaultClient;
    const pouch = (await store.getPouch("uber-eats"))!;
    expect((await ensureOnChain(fake, [pouch]))[0].balance).toBe(0);
    expect(createPouch).not.toHaveBeenCalled();
    expect(topUp).not.toHaveBeenCalled();
    getBalance.mockRejectedValue(new Error("missing"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An unreadable pouch is logged and skipped; startup still never creates or funds it.
    expect(await ensureOnChain(fake, [pouch])).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("will not create or fund"));
    warn.mockRestore();
    expect(createPouch).not.toHaveBeenCalled();
  });
});

describe("chain program refusals", () => {
  const refusal = () => new Error("Simulation failed. Message: Transaction simulation failed: custom program error: 0x1772. Logs: Program log: AnchorError thrown. Error Code: OverDailyLimit. Error Number: 6004.");
  const rejectingTransport = (): RecoveryTransport => ({
    ...transport(),
    broadcast: vi.fn(async () => programRejection(refusal())),
  });
  const chainLikeVault = (rpc: RecoveryTransport) => ({
    ...vault,
    pay: (_p: unknown, _to: string, _amount: number, orderId: string) =>
      recoverTransaction(store, `pay:${orderId}`, rpc, async () => ({ ...operation, id: `pay:${orderId}`, pouchId: "uber-eats" }), { kind: "pay", pouchId: "uber-eats" }),
  }) as unknown as MockVaultClient;

  it("turns a preflight program error into VaultRejected without leaving a pending payment", async () => {
    await expect(recoverTransaction(store, operation.id, rejectingTransport(), async () => operation, operation)).rejects.toBeInstanceOf(VaultRejected);
    // Non-program failures stay unresolved so the same signature is retried.
    const timeout = { ...transport(), broadcast: vi.fn().mockRejectedValue(new Error("rpc timeout")) };
    await expect(recoverTransaction(store, operation.id, timeout, async () => operation, operation)).rejects.toThrow("not confirmed");
  });

  it("marks the order rejected with the program code, and the rejected order can be cancelled", async () => {
    const order = await draft();
    const deps = { store, vault: chainLikeVault(rejectingTransport()) };
    await expect(confirmOrder(deps, order.id)).rejects.toMatchObject({ status: 422, code: "OverDailyLimit" });
    const saved = (await store.getOrder(order.id))!;
    expect(saved.status).toBe("rejected");
    expect(saved.rejectReason).toBe("OverDailyLimit");
    // Confirm is terminal: no second payment attempt for a rejected order.
    await expect(confirmOrder(deps, order.id)).rejects.toMatchObject({ status: 409 });
    expect((await cancelOrder(deps, order.id)).status).toBe("cancelled");
  });
});
