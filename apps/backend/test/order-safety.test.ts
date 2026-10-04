import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Order, toMicros } from "@solpouch/shared";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { getMerchant } from "../src/merchants/index.js";
import { confirmOrder, createDraft } from "../src/services/orders.js";
import { findOnline } from "../src/ai/findOnline.js";
import { clearFindCache } from "../src/ai/findCart.js";
import { readback } from "../src/routes/voice.js";
import { ownedSeed, TEST_USER } from "./helpers.js";

vi.mock("../src/ai/findOnline.js", async (orig) => ({ ...(await orig<typeof import("../src/ai/findOnline.js")>()), findOnline: vi.fn() }));
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const fixtureFind = {
  store: { name: "Fixture Store", domain: "a.example", url: "https://a.example" },
  onInstacart: false,
  fallback: false,
  items: [{ requested: "chainsaw", name: "Fixture chainsaw", unitPrice: 299.99 }],
};
let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  vi.clearAllMocks();
  clearFindCache();
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
  vi.mocked(findOnline).mockResolvedValue(fixtureFind);
});
const deps = () => ({ store, vault });
const legacy = (overrides: Partial<Order> = {}): Order => ({
  id: "11111111111111111111111111111111", pouchId: "groceries", merchantId: "web:a.example",
  request: "chainsaw", lines: [], total: toMicros(1), status: "draft", createdAt: new Date().toISOString(), ...overrides,
});

describe("order payment boundaries", () => {
  it("keeps real search results and checkout links but never pays an estimate", async () => {
    const order = await createDraft(deps(), TEST_USER, "a chainsaw", "groceries");
    expect(order.store?.domain).toBe("a.example");
    expect(order.fulfillment?.checkoutUrl).toBe("https://a.example");
    const pay = vi.spyOn(vault, "pay");
    const balance = (await store.getPouch("groceries"))!.balance;
    await expect(confirmOrder(deps(), TEST_USER, order.id)).rejects.toMatchObject({ code: "WebCheckoutRequired" });
    expect(pay).not.toHaveBeenCalled();
    expect((await store.getPouch("groceries"))!.balance).toBe(balance);
    expect((await store.getOrder(order.id))!.status).toBe("draft");
    expect(readback(order)).toContain("checkout with the retailer");
    expect(readback(order)).not.toContain("Should I place it");
  });

  it("checks the current exact store rule even when sites share a checkout wallet", async () => {
    const order = await store.saveOrder(legacy());
    const pouch = (await store.getPouch(order.pouchId))!;
    pouch.allowedMerchantIds = ["web:b.example"];
    await store.savePouch(pouch);
    const pay = vi.spyOn(vault, "pay");
    await expect(confirmOrder(deps(), TEST_USER, order.id)).rejects.toMatchObject({ code: "MerchantNotAllowed" });
    expect(pay).not.toHaveBeenCalled();
    expect((await store.getOrder(order.id))!.status).toBe("draft");
  });

  it("also rechecks removed catalog merchants", async () => {
    const order = await createDraft(deps(), TEST_USER, "pad thai", "uber-eats");
    const pouch = (await store.getPouch(order.pouchId))!;
    pouch.allowedMerchantIds = ["mountain-market"];
    await store.savePouch(pouch);
    const pay = vi.spyOn(vault, "pay");
    await expect(confirmOrder(deps(), TEST_USER, order.id)).rejects.toMatchObject({ code: "MerchantNotAllowed" });
    expect(pay).not.toHaveBeenCalled();
  });

  it.each([
    legacy(), // Legacy fallback with no store, estimated flag or provenance.
    legacy({ merchantId: "unknown-store" }),
    legacy({ merchantId: "mountain-market", store: fixtureFind.store }),
    legacy({ merchantId: "mountain-market", fulfillment: { via: "service", label: "Buyer" } }),
    legacy({ merchantId: "mountain-market", lines: [{ requested: "chainsaw", requestedQty: 1, qty: 1, lineTotal: 1, matchScore: 1, substitution: false, product: { id: "legacy", merchantId: "mountain-market", name: "chainsaw", unitPrice: 1, inStock: true, estimated: true } }] }),
  ])("blocks legacy reference drafts without relying on new provenance fields: %j", async (draft) => {
    await store.saveOrder(draft);
    const pay = vi.spyOn(vault, "pay");
    await expect(confirmOrder(deps(), TEST_USER, draft.id)).rejects.toMatchObject({ code: "WebCheckoutRequired" });
    expect(pay).not.toHaveBeenCalled();
  });

  it.each([[null, "NotFound"], [{ ...fixtureFind, fallback: true }, "SearchUnavailable"]] as const)("fails closed on empty or fallback search results", async (result, code) => {
    vi.mocked(findOnline).mockResolvedValue(result as any);
    await expect(createDraft(deps(), TEST_USER, "chainsaw", "groceries")).rejects.toMatchObject({ code });
    expect(await store.listOrders()).toEqual([]);
  });
});
