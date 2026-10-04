import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { aiProvider } from "../src/ai/provider.js";
import { parseRequest } from "../src/ai/gemini.js";
import { findOnline } from "../src/ai/findOnline.js";
import { authHeaders, ownedSeed } from "./helpers.js";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: sdk.create };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

  it("chat POST uses claudeReply", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockResolvedValue({ content: [{ type: "text", text: "Hello from Claude" }] });
    const store = new MemoryStore(ownedSeed());
    const app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
    const auth = await authHeaders(store);
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(await res.json()).toEqual({ reply: "Hello from Claude", mode: "claude" });
    expect(sdk.create.mock.calls[0][0].max_tokens).toBe(700);
  });

  it("findOnline parses the final text block", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    const json = { storeName: "Shop", domain: "shop.ca", storeUrl: "https://shop.ca", onInstacart: false, items: [{ requested: "oat milk", name: "Oat Milk", unitPrice: 4.5, url: "https://shop.ca/p" }] };
    sdk.create.mockResolvedValue({
      content: [
        { type: "text", text: "Searching {not json}" },
        { type: "server_tool_use", name: "web_search" },
        { type: "web_search_tool_result", content: [] },
        { type: "text", text: JSON.stringify(json) },
      ],
    });
    const r = await findOnline([{ requested: "oat milk", qty: 1 }]);
    expect(r?.fallback).toBe(false);
    expect(r?.store.domain).toBe("shop.ca");
    expect(r?.items[0].unitPrice).toBe(4.5);
  });

  it("parseRequest uses tool_use input", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockResolvedValue({ content: [{ type: "tool_use", name: "shopping_list", input: { pouchHint: "groceries", items: [{ requested: "oat milk", qty: 2 }] } }] });
    expect(await parseRequest("two oat milks")).toEqual({ pouchHint: "groceries", items: [{ requested: "oat milk", qty: 2 }] });
    expect(sdk.create.mock.calls[0][0].tool_choice).toEqual({ type: "tool", name: "shopping_list" });
  });

  it("falls back on Claude error", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fake");
    sdk.create.mockRejectedValue(new Error("boom"));
    const p = await parseRequest("3 boxes of screws");
    expect(p.items).toEqual([{ requested: "screws", qty: 3 }]);
    const f = await findOnline([{ requested: "chainsaw", qty: 1 }]);
    expect(f).toBeNull();
  });
});
