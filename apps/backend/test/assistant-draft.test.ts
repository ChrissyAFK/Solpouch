// apps/backend/test/assistant-draft.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { getMerchant } from "../src/merchants/index.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { createDraft, HttpError } from "../src/services/orders.js";
import { SearchUnavailableError } from "../src/ai/storeMatch.js";
import { ownedSeed, TEST_USER } from "./helpers.js";

const m = vi.hoisted(() => ({ understand: vi.fn(), findCart: vi.fn() }));
// The SDK is mocked so the catalog matcher never reaches the network; it falls back to the offline matcher.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => { throw new Error("offline in tests"); } }; } }));
vi.mock("../src/ai/understand.js", () => ({ understand: (t: string) => m.understand(t) }));
vi.mock("../src/ai/findCart.js", () => ({ findCart: (...a: any[]) => m.findCart(...a), clearFindCache: () => {} }));

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "fake");
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
afterEach(() => { vi.unstubAllEnvs(); m.understand.mockReset(); m.findCart.mockReset(); });
const draft = (req: string, pouch?: string) => createDraft({ store, vault }, TEST_USER, req, pouch);
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e);
const find = (items: any[]) => ({ store: { name: "Popeyes", domain: "popeyes.ca", url: "https://popeyes.ca" }, onInstacart: false, fallback: false, items });

describe("createDraft with the assistant", () => {
  it("returns the clarifying question and does not search", async () => {
    m.understand.mockResolvedValue({ items: [{ requested: "screws", qty: 1 }], clarify: { question: "What size and type of screws?", reason: "missing_detail" } });
    const e = await fail(draft("screws"));
    expect(e).toBeInstanceOf(HttpError);
    expect([e.status, e.code, e.message]).toEqual([400, "NeedClarification", "What size and type of screws?"]);
    expect(m.findCart).not.toHaveBeenCalled();
  });
  it("a store with no items and no budget asks what they want", async () => {
    m.understand.mockResolvedValue({ store: "Popeyes", items: [] });
    const e = await fail(draft("a Popeyes order"));
    expect([e.code, e.message]).toEqual(["NeedClarification", "What would you like from Popeyes?"]);
  });
  it("verified lines are not estimates; unverified lines are", async () => {
    m.understand.mockResolvedValue({ store: "Popeyes", items: [{ requested: "tenders combo", qty: 1 }, { requested: "biscuit", qty: 2 }] });
    m.findCart.mockResolvedValue(find([
      { requested: "tenders combo", name: "3pc Tenders Combo", unitPrice: 11.99, url: "https://popeyes.ca/menu/tenders", verified: true },
      { requested: "biscuit", name: "Biscuit", unitPrice: 1.99, verified: false },
    ]));
    const o = await draft("tenders combo and 2 biscuits from Popeyes");
    expect(o.lines.map((l) => [l.product?.estimated, l.note, l.matchScore])).toEqual([
      [false, undefined, 0.95],
      [true, "Estimated price from popeyes.ca. Check it before paying.", 0.8],
    ]);
  });
  it("with a provider configured, everyday items go to search, not the built-in catalog", async () => {
    m.understand.mockResolvedValue({ items: [{ requested: "eggs", qty: 2 }, { requested: "bread", qty: 1 }] });
    m.findCart.mockResolvedValue(null);
    const e = await fail(draft("2 eggs and 1 bread"));
    expect(m.findCart).toHaveBeenCalled();
    expect(e.code).toBe("NotFound");
  });
  it("a named built-in merchant still uses its catalog", async () => {
    const name = getMerchant("mountain-market")!.name;
    m.understand.mockResolvedValue({ store: name, items: [{ requested: "eggs", qty: 1 }] });
    const o = await draft(`eggs from ${name}`);
    expect(o.merchantId).toBe("mountain-market");
    expect(m.findCart).not.toHaveBeenCalled();
  });
  it("when every pouch allows only catalog merchants, a catalog draft is made without a search", async () => {
    for (const p of await store.listPouches(TEST_USER)) await store.savePouch({ ...p, allowedMerchantIds: ["mountain-market"], frozen: false });
    m.understand.mockResolvedValue({ items: [{ requested: "eggs", qty: 1 }] });
    const o = await draft("eggs");
    expect(o.merchantId).toBe("mountain-market");
    expect(m.findCart).not.toHaveBeenCalled();
  });
  it("assistant or search down is 503 SearchUnavailable", async () => {
    m.understand.mockRejectedValue(new SearchUnavailableError("down"));
    let e = await fail(draft("milk"));
    expect([e.status, e.code]).toEqual([503, "SearchUnavailable"]);
    m.understand.mockResolvedValue({ items: [{ requested: "milk", qty: 1 }] });
    m.findCart.mockRejectedValue(new SearchUnavailableError("down"));
    e = await fail(draft("milk"));
    expect([e.status, e.code]).toEqual([503, "SearchUnavailable"]);
  });
});
