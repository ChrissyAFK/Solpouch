import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order, type TopUp } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { StoreConflictError } from "../src/store/types.js";
import { confirmOrder, createDraft, HttpError } from "../src/services/orders.js";
import { completeTopUp } from "../src/services/topups.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { VaultRejected, type VaultClient, type VaultRejectCode } from "../src/vault/types.js";
import { VOICE_CONFIRM_MIN_AGE_MS } from "../src/routes/voice.js";
import { ownedSeed, TEST_USER, voiceToken } from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const VOICE_SECRET = "fixture-only-voice-secret";
process.env.VOICE_WEBHOOK_SECRET = VOICE_SECRET;
const $ = toMicros;
const WALLET = "linked-test-wallet";

let store: MemoryStore;
let vault: MockVaultClient;
const iso = () => new Date().toISOString();
beforeEach(async () => {
  store = new MemoryStore(ownedSeed());
  await store.saveUser({ email: TEST_USER, wallet: WALLET, createdAt: iso(), updatedAt: iso() });
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
afterEach(() => vi.restoreAllMocks());

const draft = (over: Partial<Order> = {}): Order => ({
  id: `o-${Math.random().toString(16).slice(2)}`, pouchId: "uber-eats", merchantId: "thai-express", request: "pad thai",
  lines: [{requested:"item",requestedQty:1,qty:1,product:{id:"fixture",merchantId:"thai-express",name:"item",unitPrice:$(5),inStock:true},lineTotal:$(5),matchScore:1,substitution:false}], total: $(5), status: "draft", createdAt: iso(), ...over,
});
const withVault = (pay: VaultClient["pay"]): VaultClient => ({ ...vault, pay } as unknown as VaultClient);

describe("task 2: placeholder lookups are not payable", () => {
  it("refuses a draft when online lookup is unavailable", async () => {
    const err = await createDraft({ store, vault }, TEST_USER, "zzqx gadget", "groceries").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
    expect(err.message).toContain("Online search is unavailable");
    expect(await store.listOrders()).toHaveLength(0);
  });
  it("voice create_order answers with say instead of crashing", async () => {
    const app = createApp({ store, vault });
    const res = await app.request("/voice/tools/create_order", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Solpouch-Secret": VOICE_SECRET },
      body: JSON.stringify({ request: "zzqx gadget", pouchId: "groceries", user_token: await voiceToken(store) }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.say).toContain("Online search is unavailable");
    expect(j.needsConfirmation).toBe(false);
  });
});

describe("catalog pouch pick skips frozen pouches", () => {
  it("lands on the unfrozen any-store pouch", async () => {
    const base = ownedSeed()[0]!;
    store = new MemoryStore([
      { ...base, id: "frozen-allow", allowedMerchantIds: ["mountain-market"], frozen: true },
      { ...base, id: "open-any", allowedMerchantIds: [], frozen: false },
    ]);
    const order = await createDraft({ store, vault }, TEST_USER, "2 eggs");
    expect(order.pouchId).toBe("open-any");
  });
});

describe("task 3: merchant re-check on confirm", () => {
  it("rejects when the pouch no longer allows the merchant", async () => {
    const o = await store.saveOrder(draft({ merchantId: "burnaby-builders" }));
    await expect(confirmOrder({ store, vault }, TEST_USER, o.id)).rejects.toMatchObject({ status: 422, code: "MerchantNotAllowed" });
    expect(await store.getOrder(o.id)).toMatchObject({ status: "draft" });
  });
  it("any-store pouch (empty list) passes", async () => {
    const o = await store.saveOrder(draft({ pouchId: "groceries", merchantId: "burnaby-builders" }));
    expect((await confirmOrder({ store, vault }, TEST_USER, o.id)).status).toBe("paid");
  });
});

describe("task 4: voice confirm needs the read-back first", () => {
  const call = async (tool: string, body: object) =>
    createApp({ store, vault }).request(`/voice/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Solpouch-Secret": VOICE_SECRET },
      body: JSON.stringify({ ...body, user_token: await voiceToken(store) }),
    });
  it("refuses a fresh draft, accepts an older one", async () => {
    const o = await store.saveOrder(draft());
    const early = await (await call("confirm_order", { orderId: o.id, version:o.version })).json();
    expect(early.status).toBe("draft");
    expect(early.say).toContain("say yes again");
    expect((await store.getOrder(o.id))!.status).toBe("draft");
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + VOICE_CONFIRM_MIN_AGE_MS + 1000);
    const ok = await (await call("confirm_order", { orderId: o.id, version:o.version })).json();
    expect(ok.status).toBe("paid");
  });
});

describe("task 5: order end states", () => {
  const codes: VaultRejectCode[] = ["PouchFrozen", "OverDailyLimit", "PouchNotOnChain", "AgentKeyMismatch", "SignerOutOfSol", "ChainRejected", "TxFailed", "TxExpired"] as VaultRejectCode[];
  for (const code of codes) {
    it(`${code} ends rejected with the code`, async () => {
      const o = await store.saveOrder(draft());
      const v = withVault(async () => { throw new VaultRejected(code); });
      await expect(confirmOrder({ store, vault: v }, TEST_USER, o.id)).rejects.toMatchObject({ status: 422, code });
      expect(await store.getOrder(o.id)).toMatchObject({ status: "rejected", rejectReason: code });
    });
  }
  it("unexpected error before anything was journaled goes back to draft", async () => {
    const o = await store.saveOrder(draft());
    const v = withVault(async () => { throw new Error("boom"); });
    await expect(confirmOrder({ store, vault: v }, TEST_USER, o.id)).rejects.toMatchObject({ status: 503, code: "PaymentNotSent" });
    expect((await store.getOrder(o.id))!.status).toBe("draft");
  });
  it("unexpected error after a journal entry stays paying", async () => {
    const o = await store.saveOrder(draft());
    await store.saveOperation({ id: `pay:${o.id}`, kind: "pay", pouchId: "uber-eats", txSignature: "s", signedTransaction: "t", lastValidBlockHeight: 1, createdAt: iso() });
    const v = withVault(async () => { throw new Error("rpc timeout"); });
    await expect(confirmOrder({ store, vault: v }, TEST_USER, o.id)).rejects.toMatchObject({ code: "PaymentPending" });
    expect((await store.getOrder(o.id))!.status).toBe("paying");
  });
});

describe("task 6: top-ups", () => {
  const topup = (over: Partial<TopUp> = {}): TopUp => ({
    id: `t-${Math.random().toString(16).slice(2)}`, pouchId: "uber-eats", amount: $(5), reason: "r", fromWallet: WALLET,
    status: "cooling_down", readyAt: new Date(Date.now() - 1000).toISOString(), createdAt: iso(), ...over,
  });
  it("a vault rejection marks failed with failReason", async () => {
    const t = await store.saveTopUp(topup());
    const v = { ...vault, topUp: async () => { throw new VaultRejected("ChainRejected" as VaultRejectCode); } } as unknown as VaultClient;
    await expect(completeTopUp({ store, vault: v }, TEST_USER, t.id)).rejects.toMatchObject({ status: 422, code: "ChainRejected" });
    expect(await store.getTopUp(t.id)).toMatchObject({ status: "failed", failReason: "ChainRejected" });
  });
  it("403 and stays cooling_down when the wallet changed", async () => {
    const t = await store.saveTopUp(topup());
    await store.updateUser(TEST_USER, { wallet: "other-wallet" }, iso());
    await expect(completeTopUp({ store, vault }, TEST_USER, t.id)).rejects.toMatchObject({ status: 403 });
    expect((await store.getTopUp(t.id))!.status).toBe("cooling_down");
    await store.updateUser(TEST_USER, { wallet: null }, iso());
    await expect(completeTopUp({ store, vault }, TEST_USER, t.id)).rejects.toMatchObject({ status: 403 });
  });
  it("completes when the wallet still matches", async () => {
    const t = await store.saveTopUp(topup());
    expect((await completeTopUp({ store, vault }, TEST_USER, t.id)).status).toBe("completed");
  });
});

describe("task 7: users", () => {
  it("profile and wallet updates do not clobber each other", async () => {
    await store.updateUser(TEST_USER, { displayName: "Ann" }, iso());
    expect(await store.getUser(TEST_USER)).toMatchObject({ displayName: "Ann", wallet: WALLET });
    await store.updateUser(TEST_USER, { wallet: "w2" }, iso());
    expect(await store.getUser(TEST_USER)).toMatchObject({ displayName: "Ann", wallet: "w2" });
    await store.updateUser(TEST_USER, { displayName: null }, iso());
    const u = (await store.getUser(TEST_USER))!;
    expect(u.displayName).toBeUndefined();
    expect(u.wallet).toBe("w2");
  });
  it("one wallet per account in the memory store", async () => {
    await expect(store.updateUser("b@example.com", { wallet: WALLET }, iso())).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.saveUser({ email: "c@example.com", wallet: WALLET, createdAt: iso(), updatedAt: iso() })).rejects.toBeInstanceOf(StoreConflictError);
  });
});
