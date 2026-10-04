import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateFind, isPlainHostname, safeUrlForDomain } from "../src/ai/findOnline.js";
import { clampQty, cleanPrice, parseRequest, matchItems } from "../src/ai/gemini.js";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { resetVoiceLockouts } from "../src/security/auth.js";
import { ownedSeed } from "./helpers.js";

const gen = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", async (orig) => ({
  ...(await orig<any>()),
  GoogleGenAI: class {
    models = { generateContent: gen.generateContent };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetVoiceLockouts();
  vi.stubEnv("GEMINI_API_KEY", "fake");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("findOnline URL validation", () => {
  it("accepts only plain hostnames", () => {
    expect(isPlainHostname("shop.ca")).toBe(true);
    expect(isPlainHostname("www.shop.ca")).toBe(true);
    for (const bad of ["https://shop.ca", "shop.ca/x", "user@shop.ca", "shop .ca", "10.0.0.1", "[::1]", "localhost", "shop.ca:8080"]) {
      expect(isPlainHostname(bad)).toBe(false);
    }
  });

  it("keeps only https urls on the store domain or a subdomain", () => {
    expect(safeUrlForDomain("https://www.Shop.ca/p?1", "shop.ca")).toBe("https://www.shop.ca/p?1");
    expect(safeUrlForDomain("https://m.shop.ca/p", "shop.ca")).toBe("https://m.shop.ca/p");
    expect(safeUrlForDomain("http://shop.ca/p", "shop.ca")).toBeUndefined();
    expect(safeUrlForDomain("https://evilshop.ca/p", "shop.ca")).toBeUndefined();
    expect(safeUrlForDomain("https://shop.ca.evil.com/p", "shop.ca")).toBeUndefined();
    expect(safeUrlForDomain("https://shop.ca@evil.com/", "shop.ca")).toBeUndefined();
    expect(safeUrlForDomain("javascript:alert(1)", "shop.ca")).toBeUndefined();
  });

  it("validateFind drops off-domain urls and rejects odd domains", () => {
    const items = [{ requested: "milk", qty: 1 }];
    const raw = (domain: string) => ({ domain, storeUrl: "https://evil.com", items: [{ requested: "milk", unitPrice: 2, url: "https://evil.com/p" }] });
    const ok = validateFind(raw("shop.ca"), items)!;
    expect(ok.store.url).toBe("https://shop.ca");
    expect(ok.items[0].url).toBeUndefined();
    expect(validateFind(raw("https://shop.ca/x"), items)).toBeNull();
    expect(validateFind(raw("1.2.3.4"), items)).toBeNull();
  });
});

describe("gemini safety", () => {
  it("clamps quantities and drops bad prices", () => {
    expect(clampQty(1e9)).toBe(1000);
    expect(clampQty(-5)).toBe(1);
    expect(clampQty(Infinity)).toBe(1);
    expect(clampQty("abc")).toBe(1);
    expect(clampQty(2.6)).toBe(3);
    expect(cleanPrice(-1)).toBeUndefined();
    expect(cleanPrice(Infinity)).toBeUndefined();
    expect(cleanPrice(NaN)).toBeUndefined();
    expect(cleanPrice(4.5)).toBe(4.5);
  });

  it("sends a 15s one-attempt timeout on both requests and clamps parsed qty", async () => {
    gen.generateContent.mockResolvedValueOnce({ text: JSON.stringify({ items: [{ requested: "screws", qty: 99999 }] }) });
    const parsed = await parseRequest("lots of screws");
    expect(parsed.items[0].qty).toBe(1000);
    expect(gen.generateContent.mock.calls[0][0].config.httpOptions).toEqual({ timeout: 15_000, retryOptions: { attempts: 1 } });

    const product = { id: "p1", name: "Screws", unitPrice: 2, inStock: true } as any;
    gen.generateContent.mockResolvedValueOnce({ text: JSON.stringify([{ requested: "screws", requestedQty: 5, productId: "p1", qty: 1e9, matchScore: 1, substitution: false }]) });
    const lines = await matchItems([{ requested: "screws", qty: 5 }], [product]);
    expect(lines[0].qty).toBe(1000);
    expect(gen.generateContent.mock.calls[1][0].config.httpOptions).toEqual({ timeout: 15_000, retryOptions: { attempts: 1 } });
  });
});

describe("voice create_order limits", () => {
  it("shares the 10/min gemini limiter", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("VOICE_WEBHOOK_SECRET", "s3cret-fixture");
    const store = new MemoryStore(ownedSeed());
    const app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
    const call = () => app.request("/voice/tools/create_order", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Solpouch-Secret": "s3cret-fixture" }, body: "{}",
    });
    for (let i = 0; i < 10; i++) expect((await call()).status).not.toBe(429);
    expect((await call()).status).toBe(429);
  });
});
