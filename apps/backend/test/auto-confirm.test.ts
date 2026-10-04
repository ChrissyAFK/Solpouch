import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order, type Pouch } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getCatalog, getMerchant } from "../src/merchants/index.js";
import { AUTO_CONFIRM_MATCH, autoConfirmEligible, confirmOrder, createDraft } from "../src/services/orders.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { VaultRejected } from "../src/vault/types.js";
import { authHeaders, ownedSeed, TEST_USER, voiceToken } from "./helpers.js";

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
      { matchScore: AUTO_CONFIRM_MATCH - 0.01 },
      { matchScore: 0.5 },
      { note: "Picked a different size" },
      { product: null, qty: 0, lineTotal: 0 },
      { product: { ...eggs, inStock: false } },
      { qty: 1, lineTotal: eggs.unitPrice },
    ]) {
      const l = { ...line, ...bad };
      const total = l.lineTotal + line.lineTotal;
      expect(autoConfirmEligible(pouch(), order({ lines: [line, l], total })), JSON.stringify(bad)).toBe(false);
    }
    expect(autoConfirmEligible(pouch(), order({ lines: [{ ...line, matchScore: AUTO_CONFIRM_MATCH }] }))).toBe(true);
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
    // Seeds always ask (confirmAbove 0); these tests opt Groceries into a $30 auto-pay amount.
    store = new MemoryStore(ownedSeed().map((p) => (p.id === "groceries" ? { ...p, confirmAbove: $(30) } : p)));
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

  it("never auto-pays over voice: it asks for the spoken yes and carries the version", async () => {
    const r = await (await voice("large eggs")).json();
    expect(r).toMatchObject({ needsConfirmation: true });
    expect(r.autoPaid).toBeUndefined();
    expect(r.version).toBeGreaterThan(0);
    expect(r.say).toContain("Large Eggs");
    expect((await store.getPouch("groceries"))!.balance).toBe($(300));
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

  it("reports a refusal from the vault on the order route without claiming it was paid", async () => {
    vi.spyOn(vault, "pay").mockRejectedValueOnce(new VaultRejected("OverDailyLimit"));
    const res = await postOrder("large eggs");
    expect(res.status).toBe(201);
    expect((await res.json()).status).not.toBe("paid");
    expect((await store.getPouch("groceries"))!.balance).toBe($(300));
  });

  it("re-checks eligibility under the lock: confirmAbove set to 0 after the draft leaves a draft, unpaid", async () => {
    const deps = { store, vault };
    const draft = await createDraft(deps, TEST_USER, "large eggs", "groceries");
    const p = (await store.getPouch("groceries"))!;
    expect(autoConfirmEligible(p, draft)).toBe(true);
    await store.savePouch({ ...p, confirmAbove: 0 });
    const result = await confirmOrder(deps, TEST_USER, draft.id, undefined, { auto: true });
    expect(result.status).toBe("draft");
    expect((await store.getPouch("groceries"))!.balance).toBe($(300));
  });

  it("returns autoPaid and autoPayError on the order route", async () => {
    const ok = await (await postOrder("large eggs")).json();
    expect(ok.autoPaid).toBe(true);
    expect(ok.autoPayError).toBeUndefined();
    vi.spyOn(vault, "pay").mockRejectedValueOnce(new VaultRejected("OverDailyLimit"));
    const refused = await (await postOrder("large eggs")).json();
    expect(refused.autoPaid).toBe(false);
    expect(refused.autoPayError).toMatchObject({ code: "OverDailyLimit" });
  });

  it("leaves the explicit confirm path unchanged for drafts", async () => {
    const p = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...p, confirmAbove: 0 });
    const draft = await (await postOrder("large eggs")).json();
    const res = await createApp({ store, vault }).request(`/orders/${draft.id}/confirm`, { method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders(store) }, body: JSON.stringify({ version: draft.version }) });
    expect((await res.json()).status).toBe("paid");
  });
});
