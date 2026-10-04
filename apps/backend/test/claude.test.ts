import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { aiProvider } from "../src/ai/provider.js";
import { matchItems, parseRequest } from "../src/ai/gemini.js";
import { findOnline, SearchUnavailableError } from "../src/ai/findOnline.js";
import { OrderInputError } from "../src/services/orderValidation.js";
import { authHeaders, ownedSeed } from "./helpers.js";

// The Anthropic SDK is mocked: no request ever leaves the test process.
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: sdk.create }; } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function chatApp() {
  const store = new MemoryStore(ownedSeed());
  const app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
  const auth = await authHeaders(store);
  const ask = (content: string) => app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ messages: [{ role: "user", content }] }) });
  return { app, auth, ask };
}

describe("claude provider", () => {
  it("prefers claude over gemini over none", () => {
    expect(aiProvider()).toBe("none");
    vi.stubEnv("GEMINI_API_KEY", "g");
    expect(aiProvider()).toBe("gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", "  ");
    expect(aiProvider()).toBe("gemini");
    vi.stubEnv("ANTHROPIC_API_KEY", "a");
    expect(aiProvider()).toBe("claude");
  });

  it("chat uses Claude with the shared system prompt and reports claude mode", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockResolvedValue({ content: [{ type: "text", text: "Hello from Claude" }] });
    const { app, auth, ask } = await chatApp();
    expect(await (await app.request("/chat/status", { headers: auth })).json()).toEqual({ mode: "claude" });
    expect(await (await ask("hi")).json()).toEqual({ reply: "Hello from Claude", mode: "claude" });
    const call = sdk.create.mock.calls[0][0];
    expect(call.max_tokens).toBe(700);
    expect(call.model).toBe("claude-haiku-4-5-20251001");
    expect(call.system).toContain("cannot transact");
    expect(call.tools).toBeUndefined();
  });

  it("returns a sanitized 503 when Claude fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockRejectedValue(new Error("secret-key-provider-error"));
    const res = await (await chatApp()).ask("hi");
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("secret-key");
  });

  it("findOnline parses the text after the last search result", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const json = { storeName: "Shop", domain: "shop.ca", storeUrl: "https://shop.ca", onInstacart: false, items: [{ requested: "oat milk", name: "Oat Milk", unitPrice: 4.5, url: "https://shop.ca/p" }] };
    sdk.create.mockResolvedValue({ content: [
      { type: "text", text: "Searching {not json}" },
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result", content: [] },
      { type: "text", text: JSON.stringify(json) },
    ] });
    const r = await findOnline([{ requested: "oat milk", qty: 1 }]);
    expect(r).toMatchObject({ fallback: false, store: { domain: "shop.ca" }, items: [{ unitPrice: 4.5 }] });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("findOnline retries once for JSON, then gives no quote rather than inventing one", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockResolvedValue({ content: [{ type: "text", text: "no products found" }] });
    expect(await findOnline([{ requested: "chainsaw", qty: 1 }])).toBeNull();
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(sdk.create.mock.calls[1][0].messages).toHaveLength(3);
    sdk.create.mockRejectedValue(new Error("boom"));
    await expect(findOnline([{ requested: "chainsaw", qty: 1 }])).rejects.toBeInstanceOf(SearchUnavailableError);
  });

  it("parseRequest uses forced tool output and keeps quantity validation", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "shopping_list", input: { pouchHint: "groceries", items: [{ requested: "oat milk", qty: 2 }] } }] });
    expect(await parseRequest("two oat milks")).toEqual({ pouchHint: "groceries", items: [{ requested: "oat milk", qty: 2 }] });
    expect(sdk.create.mock.calls[0][0].tool_choice).toEqual({ type: "tool", name: "shopping_list" });
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "shopping_list", input: { items: [{ requested: "oat milk", qty: 2.5 }] } }] });
    await expect(parseRequest("oat milk")).rejects.toBeInstanceOf(OrderInputError);
  });

  it("matchItems only accepts in-stock catalog ids and validates the cart", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const catalog = [
      { id: "p1", name: "Oat Milk", unitPrice: 4_000_000, inStock: true },
      { id: "p2", name: "Soy Milk", unitPrice: 3_000_000, inStock: false },
    ] as any;
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "matched_lines", input: { lines: [
      { requested: "oat milk", requestedQty: 2, productId: "p1", qty: 2, matchScore: 0.9, substitution: false },
      { requested: "soy milk", requestedQty: 1, productId: "p2", qty: 1, matchScore: 0.9, substitution: false },
    ] } }] });
    const lines = await matchItems([{ requested: "oat milk", qty: 2 }, { requested: "soy milk", qty: 1 }], catalog);
    expect(lines.map((l) => [l.product?.id ?? null, l.qty, l.lineTotal])).toEqual([["p1", 2, 8_000_000], [null, 0, 0]]);
  });

  it("takes requestedQty from the parsed request, so a model that changes the quantity cannot make a line look exact", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const catalog = [{ id: "p1", name: "Oat Milk", unitPrice: 4_000_000, inStock: true }] as any;
    // The match call claims 3 were requested; the parsed request asked for 1.
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "matched_lines", input: { lines: [
      { requested: "oat milk", requestedQty: 3, productId: "p1", qty: 3, matchScore: 1, substitution: false },
    ] } }] });
    const [line] = await matchItems([{ requested: "oat milk", qty: 1 }], catalog);
    expect(line).toMatchObject({ requestedQty: 1, qty: 3, note: expect.stringContaining("asked for 1") });
  });

  it("uses the offline matcher when the model's lines do not line up with the parsed items", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const catalog = [{ id: "p1", name: "Oat Milk", unitPrice: 4_000_000, inStock: true }, { id: "p2", name: "Soy Milk", unitPrice: 3_000_000, inStock: true }] as any;
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "matched_lines", input: { lines: [
      { requested: "oat milk", requestedQty: 2, productId: "p1", qty: 2, matchScore: 1, substitution: false },
    ] } }] });
    const lines = await matchItems([{ requested: "oat milk", qty: 2 }, { requested: "soy milk", qty: 1 }], catalog);
    expect(lines.map((l) => [l.requested, l.product?.id, l.requestedQty, l.qty])).toEqual([["oat milk", "p1", 2, 2], ["soy milk", "p2", 1, 1]]);
  });

  it("does not auto-pay when the match call returns qty 3 / requestedQty 3 for a request of 1", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const store = new MemoryStore(ownedSeed());
    const g = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...g, confirmAbove: g.maxPerOrder });
    const app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
    sdk.create
      .mockResolvedValueOnce({ content: [{ type: "tool_use", name: "shopping_list", input: { items: [{ requested: "large eggs", qty: 1 }] } }] })
      .mockResolvedValueOnce({ content: [{ type: "tool_use", name: "matched_lines", input: { lines: [
        { requested: "large eggs", requestedQty: 3, productId: "mm-eggs", qty: 3, matchScore: 1, substitution: false, note: null },
      ] } }] });
    const res = await app.request("/orders", { method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders(store) }, body: JSON.stringify({ request: "large eggs", pouchId: "groceries" }) });
    expect(res.status).toBe(201);
    const o = await res.json();
    expect(o.status).toBe("draft");
    expect(o.lines[0]).toMatchObject({ requestedQty: 1, qty: 3 });
    expect((await store.getPouch("groceries"))!.balance).toBe(g.balance);
  });

  it("falls back to the offline parser when Claude errors", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockRejectedValue(new Error("boom"));
    expect((await parseRequest("3 boxes of screws")).items).toEqual([{ requested: "screws", qty: 3 }]);
    await expect(findOnline([{ requested: "chainsaw", qty: 1 }])).rejects.toBeInstanceOf(SearchUnavailableError);
  });
});
