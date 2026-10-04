import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order, type Pouch } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getCatalog, getMerchant } from "../src/merchants/index.js";
import { MATCH_THRESHOLD, autoConfirmEligible } from "../src/services/orders.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { VaultRejected } from "../src/vault/types.js";
import { authHeaders, ownedSeed, voiceToken } from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ELEVENLABS_TOOL_SECRET;

const $ = toMicros;
const eggs = getCatalog("mountain-market").find((p) => p.id === "mm-eggs")!;

const pouch = (over: Partial<Pouch> = {}): Pouch => ({
  id: "groceries", address: "addr", name: "Groceries", balance: $(300), maxPerOrder: $(120), dailyLimit: $(150),
  spentToday: 0, confirmAbove: $(30), allowedMerchantIds: [], frozen: false, ...over,
});
const order = (over: Partial<Order> = {}): Order => ({
  id: "a".repeat(32), pouchId: "groceries", merchantId: "mountain-market", request: "eggs",
  lines: [{ requested: "eggs", requestedQty: 2, product: eggs, qty: 2, lineTotal: eggs.unitPrice * 2, matchScore: 1, substitution: false }],
  total: eggs.unitPrice * 2, status: "draft", createdAt: new Date().toISOString(), fulfillment: { via: "direct", label: "Mountain Market" }, ...over,
});
const line = order().lines[0];

describe("autoConfirmEligible guards", () => {
  it("accepts an exact catalog cart within the auto-pay amount", () => {
    expect(autoConfirmEligible(pouch(), order())).toBe(true);
    expect(autoConfirmEligible(pouch({ confirmAbove: order().total }), order())).toBe(true);
  });
  it("never auto-pays when confirmAbove is unset (0 = always confirm)", () => {
    expect(autoConfirmEligible(pouch({ confirmAbove: 0 }), order())).toBe(false);
  });
  it("requires the total to be at or below confirmAbove", () => {
    expect(autoConfirmEligible(pouch({ confirmAbove: order().total - 1 }), order())).toBe(false);
  });
  it("never auto-pays a web search estimate or checkout reference", () => {
    expect(autoConfirmEligible(pouch(), order({ store: { name: "Shop", domain: "shop.example" } }))).toBe(false);
    expect(autoConfirmEligible(pouch(), order({ merchantId: "web:shop.example" }))).toBe(false);
    expect(autoConfirmEligible(pouch(), order({ fulfillment: { via: "instacart", label: "Instacart" } }))).toBe(false);
    expect(autoConfirmEligible(pouch(), order({ lines: [{ ...line, product: { ...eggs, estimated: true } }] }))).toBe(false);
  });
  it("requires every line to be an exact, unflagged match", () => {
    for (const bad of [
      { substitution: true },
      { matchScore: MATCH_THRESHOLD - 0.01 },
      { note: "Picked a different size" },
      { product: null, qty: 0, lineTotal: 0 },
      { product: { ...eggs, inStock: false } },
      { qty: 1, lineTotal: eggs.unitPrice },
    ]) {
      const l = { ...line, ...bad };
      const total = l.lineTotal + line.lineTotal;
      expect(autoConfirmEligible(pouch(), order({ lines: [line, l], total })), JSON.stringify(bad)).toBe(false);
    }
    expect(autoConfirmEligible(pouch(), order({ lines: [{ ...line, matchScore: MATCH_THRESHOLD }] }))).toBe(true);
  });
  it("leaves the draft alone when the pouch rules would refuse it", () => {
    expect(autoConfirmEligible(pouch({ frozen: true }), order())).toBe(false);
    expect(autoConfirmEligible(pouch({ balance: $(1) }), order())).toBe(false);
    expect(autoConfirmEligible(pouch({ maxPerOrder: $(1) }), order())).toBe(false);
    expect(autoConfirmEligible(pouch({ spentToday: $(149) }), order())).toBe(false);
    expect(autoConfirmEligible(pouch({ allowedMerchantIds: ["thai-express"] }), order())).toBe(false);
    expect(autoConfirmEligible(pouch(), order({ status: "paid" }))).toBe(false);
  });
});

describe("auto-confirm through the order and voice routes", () => {
  let store: MemoryStore;
  let vault: MockVaultClient;
  beforeEach(() => {
    store = new MemoryStore(ownedSeed());
    vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
  });
  const postOrder = async (request: string) => (await createApp({ store, vault }).request("/orders", {
    method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders(store) }, body: JSON.stringify({ request, pouchId: "groceries" }),
  }));
  const voice = async (request: string) => (await createApp({ store, vault }).request("/voice/tools/create_order", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request, pouchId: "groceries", user_token: await voiceToken(store) }),
  }));

  it("pays an exact cart within confirmAbove at once and moves the money", async () => {
    const res = await postOrder("large eggs");
    expect(res.status).toBe(201);
    const o = await res.json();
    expect(o.status).toBe("paid");
    expect(o.txSignature).toBeTruthy();
    expect((await store.getPouch("groceries"))!.balance).toBe($(300) - o.total);
  });

  it("says it paid automatically over voice and still lists the items", async () => {
    const r = await (await voice("large eggs")).json();
    expect(r).toMatchObject({ autoPaid: true, needsConfirmation: false, status: "paid" });
    expect(r.say).toMatch(/^Paid automatically/);
    expect(r.say).toContain("Large Eggs");
    expect(r.say).toContain("$30.00 auto-pay amount");
  });

  it("keeps a draft when confirmAbove is 0, the total is above it, or a line was substituted", async () => {
    const p = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...p, confirmAbove: 0 });
    expect((await (await postOrder("large eggs")).json()).status).toBe("draft");
    const q = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...q, confirmAbove: $(30) });
    expect((await (await postOrder("10 large eggs")).json()).status).toBe("draft");
    const sub = await (await postOrder("oatly oat milk")).json();
    expect(sub.lines[0].substitution).toBe(true);
    expect(sub.status).toBe("draft");
    const r = await (await voice("oatly oat milk")).json();
    expect(r).toMatchObject({ needsConfirmation: true });
    expect(r.say).toContain("Should I place it?");
    expect((await store.getPouch("groceries"))!.balance).toBe($(300));
  });

  it("reports a refusal from the vault without claiming the payment went through", async () => {
    vi.spyOn(vault, "pay").mockRejectedValueOnce(new VaultRejected("OverDailyLimit"));
    const r = await (await voice("large eggs")).json();
    expect(r).toMatchObject({ autoPaid: false, status: "rejected", code: "OverDailyLimit" });
    expect(r.say).toContain("No money moved");
    expect(r.say).toContain("Large Eggs");
  });

  it("leaves the explicit confirm path unchanged for drafts", async () => {
    const p = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...p, confirmAbove: 0 });
    const draft = await (await postOrder("large eggs")).json();
    const res = await createApp({ store, vault }).request(`/orders/${draft.id}/confirm`, { method: "POST", headers: await authHeaders(store) });
    expect((await res.json()).status).toBe("paid");
  });
});
