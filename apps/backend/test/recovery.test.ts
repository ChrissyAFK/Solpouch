import { ownedSeed, TEST_USER } from "./helpers.js";
import { BN } from "@coral-xyz/anchor";
import { getAccount } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order } from "@solpouch/shared";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { SyncedVaultClient } from "../src/vault/synced.js";
import { getMerchant } from "../src/merchants/index.js";
import { confirmOrder, getOwnedOrder, listOwnedOrders } from "../src/services/orders.js";
import { completeTopUp } from "../src/services/topups.js";
import { PaymentPending, recoverTransaction, type RecoveryTransport } from "../src/vault/recovery.js";
import type { VaultOperation } from "../src/store/types.js";
import { broadcastSigned, ensureOnChain, ChainVaultClient, preflightRejectCode, statusRejectCode } from "../src/vault/chain.js";
import { VaultRejected } from "../src/vault/types.js";

vi.mock("@solana/spl-token", async (importOriginal) => ({
  ...await importOriginal<typeof import("@solana/spl-token")>(),
  getAccount: vi.fn(),
}));

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
const operation: VaultOperation = { id: "pay:one", kind: "pay", pouchId: "uber-eats", txSignature: "signature", signedTransaction: Buffer.from("signed bytes").toString("base64"), lastValidBlockHeight: 100, createdAt: "2026-10-03T00:00:00Z" };
function transport(): RecoveryTransport {
  return { status: vi.fn().mockResolvedValue({ confirmed: false, failed: false }), blockHeight: vi.fn().mockResolvedValue(50), broadcast: vi.fn().mockResolvedValue("signature"), confirm: vi.fn().mockResolvedValue({ failed: false }) };
}
async function draft() {
  return store.saveOrder({ id: "one", pouchId: "uber-eats", merchantId: "thai-express", request: "test", lines: [{ requested:"item",requestedQty:1,qty:1,product:{id:"fixture",merchantId:"thai-express",name:"item",unitPrice:toMicros(5),inStock:true},lineTotal:toMicros(5),matchScore:1,substitution:false }], total: toMicros(5), status: "draft", createdAt: new Date().toISOString() } as Order);
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

  it("signs distinct top-up IDs uniquely under one blockhash and reuses a retry",async()=> {
    const owner=Keypair.generate();
    const blockhash=Keypair.generate().publicKey.toBase58();
    const sent:string[]=[];
    const fake=Object.assign(Object.create(ChainVaultClient.prototype),{
      owner,mint:Keypair.generate().publicKey,programId:Keypair.generate().publicKey,store,
      connection:{
        getGenesisHash:async()=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),
        getBlockHeight:async()=>50,
        getSignatureStatuses:async([signature]:string[])=>({value:[sent.includes(signature)?{err:null,confirmationStatus:"confirmed"}:null]}),
        sendRawTransaction:async(bytes:Buffer)=> { const tx=Transaction.from(bytes); const sig=Buffer.from(tx.signature!).toString("hex"); sent.push(sig); return sig; },
        confirmTransaction:async()=>({value:{err:null}}),
      },
      program:{methods:{topUp:()=>({accountsPartial:()=>({instruction:async()=>SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:owner.publicKey,lamports:1})})})}},
    }) as ChainVaultClient;
    const a=await fake.topUp("uber-eats",100,"distinct-a");
    const b=await fake.topUp("uber-eats",100,"distinct-b");
    expect(a.txSignature).not.toBe(b.txSignature);
    const journal=await store.getOperation("topup:distinct-a");
    // Simulate the same journaled signature now confirmed; retry never builds/sends again.
    (fake.connection as any).getSignatureStatuses=async()=>({value:[{err:null,confirmationStatus:"confirmed"}]});
    expect(await fake.topUp("uber-eats",100,"distinct-a")).toEqual(a);
    expect(sent).toHaveLength(2);
    expect(await store.getOperation("topup:distinct-a")).toEqual(journal);
  });

  it("signs distinct withdrawal IDs uniquely under one blockhash with the ID in a memo", async () => {
    const owner = Keypair.generate();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const sent: Buffer[] = [];
    const fake = Object.assign(Object.create(ChainVaultClient.prototype), {
      owner, mint: Keypair.generate().publicKey, programId: Keypair.generate().publicKey, store,
      connection: {
        getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
        getBlockHeight: async () => 50,
        getSignatureStatuses: async () => ({ value: [null] }),
        sendRawTransaction: async (bytes: Buffer) => { sent.push(Buffer.from(bytes)); return "sig"; },
        confirmTransaction: async () => ({ value: { err: null } }),
      },
      pouchPda: () => Keypair.generate().publicKey, vaultPda: () => Keypair.generate().publicKey,
      program: { methods: { withdraw: () => ({ accountsPartial: () => ({ instruction: async () => SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 }) }) }) } },
    }) as ChainVaultClient;
    const dest = owner.publicKey.toBase58();
    const a = await fake.withdraw("uber-eats", 100, dest, "wd-a");
    const b = await fake.withdraw("uber-eats", 100, dest, "wd-b");
    expect(a.txSignature).not.toBe(b.txSignature);
    const [txA, txB] = sent.map((bytes) => Transaction.from(bytes));
    expect(txA!.serializeMessage().equals(txB!.serializeMessage())).toBe(false);
    for (const [tx, id] of [[txA!, "wd-a"], [txB!, "wd-b"]] as const) {
      const memo = tx.instructions.find((i) => i.programId.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
      expect(memo?.data.toString("utf8")).toContain(id);
    }
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
  it("keeps processed errors recoverable until confirmed failure", async () => {
    const chain = Object.create(ChainVaultClient.prototype) as ChainVaultClient;
    const status = vi.fn().mockResolvedValue({value:[{err:{InstructionError:[0,"Custom"]},confirmationStatus:"processed"}]});
    const connection = { getGenesisHash:async()=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",getSignatureStatuses:status,getBlockHeight:async()=>101,sendRawTransaction:vi.fn() };
    Object.assign(chain,{store,connection});
    await store.saveOperation(operation);
    const submit = (chain as unknown as {submit(id:string,kind:string,pouchId:string,build:unknown,signers:unknown[]):Promise<unknown>}).submit.bind(chain);
    await expect(submit(operation.id,"pay",operation.pouchId,vi.fn(),[])).rejects.toBeInstanceOf(PaymentPending);
    status.mockResolvedValue({value:[{err:{InstructionError:[0,"Custom"]},confirmationStatus:"confirmed"}]});
    await expect(submit(operation.id,"pay",operation.pouchId,vi.fn(),[])).rejects.toMatchObject({code:"TxFailed"});
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
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
  it("keeps expired transactions recoverable when RPC has no signature history", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.blockHeight = vi.fn().mockResolvedValue(101);
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, found: false });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toBeInstanceOf(PaymentPending);
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, found: true });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toThrow("expired");
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });
});

describe("definitive chain refusals", () => {
  const simulated = (code: string) => Object.assign(new Error(`Simulation failed. \nMessage: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1774. \nLogs: ["Program log: AnchorError occurred. Error Code: ${code}. Error Number: 6004."]. `), { logs: [`Program log: AnchorError occurred. Error Code: ${code}.`] });

  it("names vault errors only from simulation failures and failed statuses", () => {
    expect(preflightRejectCode(simulated("OverDailyLimit"))).toBe("OverDailyLimit");
    expect(preflightRejectCode(new Error("Simulation failed. Message: custom program error: 0x1772."))).toBe("MerchantNotAllowed");
    expect(preflightRejectCode(new Error("fetch failed: Error Code: OverDailyLimit"))).toBeUndefined();
    expect(preflightRejectCode(new Error("Simulation failed. Message: Blockhash not found."))).toBeUndefined();
    expect(statusRejectCode({ InstructionError: [1, { Custom: 6003 }] })).toBe("OverPerOrderLimit");
    expect(statusRejectCode({ InstructionError: [1, { Custom: 1 }] })).toBeUndefined();
    expect(statusRejectCode(null)).toBeUndefined();
  });

  it("turns a preflight refusal of an unseen signature into a rejection", async () => {
    const rpc = { ...transport(), rejection: preflightRejectCode };
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, seen: false });
    rpc.broadcast = vi.fn().mockRejectedValue(simulated("OverDailyLimit"));
    const result = recoverTransaction(store, operation.id, rpc, async () => operation, operation);
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultRejected);
    expect(error).toMatchObject({ code: "OverDailyLimit" });
  });

  it("never finalizes a refusal on a retry, while an earlier broadcast could still land", async () => {
    const rpc = { ...transport(), rejection: preflightRejectCode };
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, seen: false });
    rpc.broadcast = vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockRejectedValue(simulated("InsufficientFunds"));
    await expect(recoverTransaction(store, operation.id, rpc, async () => operation, operation)).rejects.toThrow("not confirmed");
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toThrow("not confirmed");
    expect(rpc.broadcast).toHaveBeenCalledTimes(2);
  });

  it("with the real client's broadcast, a retry's preflight refusal leaves the operation pending", async () => {
    const connection = { sendRawTransaction: vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockRejectedValue(simulated("OverDailyLimit")) };
    const rpc = { ...transport(), rejection: preflightRejectCode, broadcast: (bytes: Uint8Array) => broadcastSigned(connection, bytes) };
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, seen: false });
    await expect(recoverTransaction(store, operation.id, rpc, async () => operation, operation)).rejects.toBeInstanceOf(PaymentPending);
    const retry = await recoverTransaction(store, operation.id, rpc, vi.fn(), operation).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(PaymentPending);
    expect(retry).not.toBeInstanceOf(VaultRejected);
    // A first broadcast refused by preflight is still final through the same path.
    connection.sendRawTransaction.mockRejectedValue(simulated("OverDailyLimit"));
    const fresh = await recoverTransaction(store, "pay:two", rpc, async () => ({ ...operation, id: "pay:two" }), { kind: "pay", pouchId: "uber-eats" }).catch((e: unknown) => e);
    expect(fresh).toMatchObject({ code: "OverDailyLimit" });
  });

  it("stays pending when the signature may have landed or the error could hide a success", async () => {
    const seen = { ...transport(), rejection: preflightRejectCode };
    seen.status = vi.fn().mockResolvedValueOnce({ confirmed: false, failed: false, seen: false }).mockResolvedValue({ confirmed: false, failed: false, seen: true });
    seen.broadcast = vi.fn().mockRejectedValue(simulated("OverDailyLimit"));
    await expect(recoverTransaction(store, operation.id, seen, async () => operation, operation)).rejects.toThrow("not confirmed");

    const reused = { ...transport(), rejection: () => "OrderAlreadyUsed" as const };
    reused.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, seen: false });
    reused.broadcast = vi.fn().mockRejectedValue(new Error("Simulation failed. already in use"));
    await expect(recoverTransaction(store, operation.id, reused, async () => operation, operation)).rejects.toThrow("not confirmed");

    const unknown = { ...transport(), rejection: preflightRejectCode };
    unknown.status = vi.fn().mockResolvedValue({ confirmed: false, failed: false, seen: false });
    unknown.broadcast = vi.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(recoverTransaction(store, operation.id, unknown, async () => operation, operation)).rejects.toThrow("not confirmed");
  });

  it("treats a landed transaction that failed with a vault error as refused", async () => {
    await store.saveOperation(operation);
    const rpc = transport();
    rpc.status = vi.fn().mockResolvedValue({ confirmed: false, failed: true, seen: true, rejectCode: "MerchantNotAllowed" });
    await expect(recoverTransaction(store, operation.id, rpc, vi.fn(), operation)).rejects.toMatchObject({ code: "MerchantNotAllowed" });
    expect(rpc.broadcast).not.toHaveBeenCalled();
  });

  it("marks the order rejected so it is not stuck paying", async () => {
    await draft();
    vi.spyOn(vault, "pay").mockRejectedValueOnce(new VaultRejected("OverDailyLimit"));
    await expect(confirmOrder({ store, vault }, TEST_USER, "one")).rejects.toMatchObject({ status: 422, code: "OverDailyLimit" });
    expect(await store.getOrder("one")).toMatchObject({ status: "rejected", rejectReason: "OverDailyLimit" });
  });

  it("cancels a refused top-up instead of leaving it processing", async () => {
    const t = await store.saveTopUp({ id: "t1", pouchId: "uber-eats", amount: toMicros(5), reason: "test", status: "processing", readyAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString() });
    vi.spyOn(vault, "topUp").mockRejectedValueOnce(new VaultRejected("Unauthorized"));
    await expect(completeTopUp({ store, vault }, TEST_USER, t.id)).rejects.toMatchObject({ status: 422, code: "Unauthorized" });
    // HEAD and MERGE_HEAD disagreed (failed + failReason vs cancelled): kept "failed", which orders-fixes.test.ts also asserts.
    expect(await store.getTopUp("t1")).toMatchObject({ status: "failed", failReason: "Unauthorized" });
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
      connection: {}, owner, mint, store, programId: Keypair.generate().publicKey,
      payToOf: (id: string) => getMerchant(id)?.payTo,
      program: { account: { pouch: { fetch: vi.fn().mockResolvedValue(account) } } },
    }) as ChainVaultClient;
    expect(await fake.getState("uber-eats")).toEqual({ balance: 10, spentToday: 2, spentSince: new Date(account.dayStart.toNumber() * 1000).toISOString(), frozen: true, maxPerOrder: 3, dailyLimit: 4, allowedMerchantIds: ["thai-express"] });
    // An unknown key is skipped with a warning instead of breaking the listing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    account.allowedMerchants = [Keypair.generate().publicKey];
    await expect(fake.getState("uber-eats")).rejects.toThrow("differ from the chain");
  });

  it("serializes simultaneous confirmations and returns the same paid outcome", async () => {
    await draft();
    const results = await Promise.all([confirmOrder({ store, vault }, TEST_USER, "one"), confirmOrder({ store, vault }, TEST_USER, "one")]);
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
    await expect(confirmOrder({ store, vault }, TEST_USER, "one")).rejects.toThrow("recover its receipt");
    expect((await store.getOrder("one"))!.status).toBe("paying");
    const restarted = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
    expect((await confirmOrder({ store, vault: restarted }, TEST_USER, "one")).status).toBe("paid");
    expect((await store.getPouch("uber-eats"))!.balance).toBe(toMicros(95));
  });
  it("exposes only the pending signature to the owner without mutating order storage",async()=> {
    const draftOrder=await draft();
    await store.saveOrder({...draftOrder,status:"paying"});
    await store.saveOperation({...operation,id:"pay:one"});
    const before=await store.getOrder("one");
    expect((await getOwnedOrder({store,vault},"one",TEST_USER)).txSignature).toBe(operation.txSignature);
    expect((await listOwnedOrders({store,vault},TEST_USER))[0].txSignature).toBe(operation.txSignature);
    await expect(getOwnedOrder({store,vault},"one","other@example.com")).rejects.toMatchObject({status:404});
    expect(await store.getOrder("one")).toEqual(before);
    expect((await getOwnedOrder({store,vault},"one",TEST_USER)) as any).not.toHaveProperty("signedTransaction");
  });
  it("keeps uncertain payments paying instead of allowing a new draft", async () => {
    await draft();
    // A journal entry means a transaction may have been sent, so the order must stay paying.
    await store.saveOperation({ id: "pay:one", kind: "pay", pouchId: "uber-eats", txSignature: "sig", signedTransaction: "tx", lastValidBlockHeight: 1, createdAt: new Date().toISOString() });
    vi.spyOn(vault, "pay").mockRejectedValue(new Error("timeout"));
    await expect(confirmOrder({ store, vault }, TEST_USER, "one")).rejects.toMatchObject({ status: 503 });
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
    await expect(completeTopUp({ store, vault }, TEST_USER, "topup")).rejects.toMatchObject({ status: 503 });
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
    await expect(completeTopUp({ store, vault }, TEST_USER, "topup")).rejects.toMatchObject({ status: 503 });
    expect((await store.getTopUp("topup"))!.status).toBe("processing");
    const results = await Promise.all([completeTopUp({ store, vault }, TEST_USER, "topup"), completeTopUp({ store, vault }, TEST_USER, "topup")]);
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
    await expect(ensureOnChain(fake, [pouch])).rejects.toThrow("startup will not create or fund");
  });
});
