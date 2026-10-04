import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFindCache, findCart } from "../src/ai/findCart.js";
import type { WebFind } from "../src/ai/findOnline.js";

const found = (over: Partial<WebFind> = {}): WebFind => ({
  store: { name: "Store", domain: "store.ca", url: "https://store.ca" },
  onInstacart: false,
  fallback: false,
  items: [
    { requested: "deck screws", name: "Deck Screws 3in", unitPrice: 12.99, url: "https://store.ca/p/1" },
    { requested: "wood glue", name: "Wood Glue 500ml", unitPrice: 8.49, url: "https://store.ca/p/2" },
  ],
  ...over,
});
const items = [{ requested: "deck screws", qty: 1 }, { requested: "wood glue", qty: 2 }];

beforeEach(() => { clearFindCache(); vi.stubEnv("VERIFY_PRICES", "1"); });
afterEach(() => vi.unstubAllEnvs());

describe("findCart", () => {
  it("marks each item verified or not and takes the page price", async () => {
    const find = vi.fn(async () => found());
    const verify = vi.fn(async (c: { name: string }, _domain?: string) => (c.name.startsWith("Deck") ? { status: "verified" as const, unitPrice: 13.49 } : { status: "estimate" as const, reason: "blocked" }));
    const r = await findCart(items, {}, { find, verify });
    expect(r!.items.map((i) => [i.verified, i.unitPrice])).toEqual([[true, 13.49], [false, 8.49]]);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0][1]).toBe("store.ca");
  });
  it("a verify that throws leaves the item an estimate", async () => {
    const r = await findCart(items, {}, { find: async () => found(), verify: async () => { throw new Error("boom"); } });
    expect(r!.items.every((i) => i.verified === false)).toBe(true);
  });
  it("serves a repeat from the cache and returns a copy", async () => {
    const find = vi.fn(async () => found());
    const verify = async () => ({ status: "verified" as const, unitPrice: 5 });
    const a = await findCart(items, { store: "Store" }, { find, verify });
    a!.items[0].unitPrice = 999;
    const b = await findCart([...items].reverse(), { store: "store" }, { find, verify });
    expect(find).toHaveBeenCalledTimes(1);
    expect(b!.items[0].unitPrice).toBe(5);
  });
  it("keys the cache on store, cap and allowed domains", async () => {
    const find = vi.fn(async () => found());
    const verify = async () => ({ status: "verified" as const, unitPrice: 5 });
    await findCart(items, {}, { find, verify });
    await findCart(items, { allowedDomains: ["other.ca"] }, { find, verify });
    await findCart(items, { maxTotal: 15 }, { find, verify });
    await findCart(items, { store: "Elsewhere" }, { find, verify });
    expect(find).toHaveBeenCalledTimes(4);
  });
  it("verified results live 24 h, results with an estimate 1 h", async () => {
    let t = 0;
    const now = () => t;
    const find = vi.fn(async () => found());
    await findCart(items, {}, { find, verify: async () => ({ status: "verified", unitPrice: 5 }), now });
    t = 23 * 3600_000; await findCart(items, {}, { find, now });
    expect(find).toHaveBeenCalledTimes(1);
    t = 25 * 3600_000; await findCart(items, {}, { find, verify: async () => ({ status: "estimate", reason: "x" }), now });
    expect(find).toHaveBeenCalledTimes(2);
    t += 2 * 3600_000; await findCart(items, {}, { find, verify: async () => ({ status: "estimate", reason: "x" }), now });
    expect(find).toHaveBeenCalledTimes(3);
  });
  it("does not cache nothing-found or the offline fallback, and passes errors through", async () => {
    const none = vi.fn(async () => null);
    await findCart(items, {}, { find: none }); await findCart(items, {}, { find: none });
    expect(none).toHaveBeenCalledTimes(2);
    const fb = vi.fn(async () => found({ fallback: true }));
    await findCart(items, {}, { find: fb }); await findCart(items, {}, { find: fb });
    expect(fb).toHaveBeenCalledTimes(2);
    await expect(findCart(items, { store: "X" }, { find: async () => { throw new Error("down"); } })).rejects.toThrow("down");
  });
  it("VERIFY_PRICES=0 skips page checks", async () => {
    vi.stubEnv("VERIFY_PRICES", "0");
    const verify = vi.fn();
    const r = await findCart(items, {}, { find: async () => found(), verify });
    expect(verify).not.toHaveBeenCalled();
    expect(r!.items.every((i) => i.verified === false)).toBe(true);
  });
});
