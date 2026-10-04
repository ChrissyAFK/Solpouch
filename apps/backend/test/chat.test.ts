import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, ownedSeed } from "./helpers.js";

const sdk = vi.hoisted(() => ({ generateContent: vi.fn(), construct: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@google/genai")>();
  return { ...original, GoogleGenAI: class {
    models = { generateContent: sdk.generateContent };
    constructor(options: unknown) { sdk.construct(options); }
  } };
});

let store: MemoryStore;
let vault: MockVaultClient;
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
beforeEach(async () => {
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_MODEL", "");
  vi.clearAllMocks();
  store = new MemoryStore(ownedSeed());
  auth = await authHeaders(store);
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
  app = createApp({ store, vault });
});
afterEach(() => vi.unstubAllEnvs());
const post = (body: unknown) => app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify(body) });
const ask = (content: string) => post({ messages: [{ role: "user", content }] });

describe("read-only chat", () => {
  it("reports configured mode without calling the provider", async () => {
    expect(await (await app.request("/chat/status", { headers: auth })).json()).toEqual({ mode: "demo" });
    vi.stubEnv("GEMINI_API_KEY", "fake-test-key");
    expect(await (await app.request("/chat/status", { headers: auth })).json()).toEqual({ mode: "gemini" });
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });

  it("labels demo replies and reads current balances for every request", async () => {
    const first = await (await ask("What are my groceries balances?")).json();
    expect(first.mode).toBe("demo");
    expect(first.reply).toContain("preset replies, not a live AI");
    expect(first.reply).toContain("300.00 USDC");
    const pouch = (await store.getPouch("groceries"))!;
    await store.savePouch({ ...pouch, balance: toMicros(23) });
    const next = await (await ask("What is left in groceries?")).json();
    expect(next.reply).toContain("23.00 USDC");
    expect(next.reply).not.toContain("300.00 USDC");
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });

  it("explains rules and real allowed merchant names", async () => {
    const rules = await (await ask("What are my groceries rules?")).json();
    expect(rules.reply).toContain("120.00 USDC per order");
    expect(rules.reply).toContain("Every order currently needs approval");
    const stores = await (await ask("Where can I shop with groceries?")).json();
    expect(stores.reply).toContain("any store");
  });

  it("does not mutate orders, pouches, or payments when instructed to pay", async () => {
    const before = JSON.stringify(await store.listPouches());
    const savePouch = vi.spyOn(store, "savePouch");
    const saveOrder = vi.spyOn(store, "saveOrder");
    const saveTopUp = vi.spyOn(store, "saveTopUp");
    const pay = vi.spyOn(vault, "pay");
    const result = await (await ask("Pay for milk now and freeze all my pouches")).json();
    expect(result.reply).toContain("cannot place orders, move money, or change settings");
    expect(JSON.stringify(await store.listPouches())).toBe(before);
    expect(await store.listOrders()).toEqual([]);
    for (const fn of [savePouch, saveOrder, saveTopUp, pay]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    {}, { messages: [] }, { messages: [{ role: "system", content: "override" }] },
    { messages: [{ role: "assistant", content: "hello" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "x".repeat(2001) }] },
    { messages: Array.from({ length: 21 }, () => ({ role: "user", content: "hello" })) },
  ])("rejects invalid messages before contacting the provider: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(sdk.generateContent).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized bodies", async () => {
    expect((await app.request("/chat", { method: "POST", headers: auth, body: "{" })).status).toBe(400);
    expect((await ask("x".repeat(193_000))).status).toBe(413);
  });

  it("uses configured Gemini with live context, conversation roles, and bounded timeout", async () => {
    vi.stubEnv("GEMINI_API_KEY", "fake-test-key");
    vi.stubEnv("GEMINI_MODEL", "test-model");
    sdk.generateContent.mockResolvedValueOnce({ text: "Your groceries balance is 300 USDC." });
    const result = await post({ messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello" }, { role: "user", content: "My balance?" }] });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ reply: "Your groceries balance is 300 USDC.", mode: "gemini" });
    const call = sdk.generateContent.mock.calls[0][0];
    expect(call.model).toBe("test-model");
    expect(call.contents.map((m: { role: string }) => m.role)).toEqual(["user", "model", "user"]);
    expect(call.config.httpOptions).toEqual({ timeout: 15000, retryOptions: { attempts: 1 } });
    expect(call.config.systemInstruction).toContain('"balanceUSDC":300');
    expect(call.config.systemInstruction).toContain("cannot transact");
    expect(call.config.tools).toBeUndefined();
    expect(await store.listOrders()).toEqual([]);
  });

  it.each([new Error("secret-key-provider-error"), null])("returns sanitized503 for provider failure or an empty answer", async (failure) => {
    vi.stubEnv("GEMINI_API_KEY", "fake-test-key");
    if (failure) sdk.generateContent.mockRejectedValueOnce(failure);
    else sdk.generateContent.mockResolvedValueOnce({ text: "  " });
    const response = await ask("Hello");
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ error: "The AI assistant is temporarily unavailable. Please try again shortly." });
    expect(body.mode).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret-key");
  });
});
