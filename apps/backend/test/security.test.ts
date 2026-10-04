import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, ownedSeed } from "./helpers.js";

delete process.env.GEMINI_API_KEY;

let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
beforeEach(async () => {
  const store = new MemoryStore(ownedSeed());
  auth = await authHeaders(store);
  const vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => 1_000_000);
  app = createApp({ store, vault });
});
afterEach(() => {
  delete process.env.ELEVENLABS_TOOL_SECRET;
  delete process.env.PUBLIC_API;
});

const json = { "Content-Type": "application/json" };
const badTopup = (ip: string) =>
  app.request("/topups", { method: "POST", headers: { ...json, ...auth, "x-forwarded-for": ip }, body: "{}" });

describe("security", () => {
  it("returns 429 with Retry-After past the limit", async () => {
    for (let i = 0; i < 5; i++) expect((await badTopup("1.1.1.1")).status).toBe(400);
    const r = await badTopup("1.1.1.1");
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await r.json()) as { error: string }).error).toMatch(/Too many requests/);
  });

  it("ignores untrusted forwarding headers", async () => {
    for (let i = 0; i < 6; i++) await badTopup("2.2.2.2");
    expect((await badTopup("2.2.2.2")).status).toBe(429);
    expect((await badTopup("3.3.3.3")).status).toBe(429);
  });

  it("does not infer tunnel trust from header presence", async () => {
    const h = { "cf-connecting-ip": "9.9.9.9" };
    expect((await app.request("/pouches", { headers: h })).status).toBe(401);
    expect((await app.request("/health", { headers: h })).status).toBe(200);
    process.env.PUBLIC_API = "all";
    expect((await app.request("/pouches", { headers: { ...h, ...auth } })).status).toBe(200);
  });

  it("CORS echoes allowed origins only", async () => {
    const ok = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await app.request("/health", { headers: { Origin: "https://evil.com" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("limits repeated invalid voice secrets", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = "right-secret";
    const call = (secret: string) =>
      app.request("/voice/tools/get_pouches", {
        method: "POST",
        headers: { ...json, "x-forwarded-for": "4.4.4.4", "X-Solpouch-Secret": secret },
        body: "{}",
      });
    for (let i = 0; i < 10; i++) expect((await call("wrong")).status).toBe(401);
    expect((await call("wrong")).status).toBe(429);
  });

  it("rejects oversized bodies with 413", async () => {
    const r = await app.request("/pouches", { method: "POST", headers: { ...json, ...auth }, body: JSON.stringify({ name: "x".repeat(70_000) }) });
    expect(r.status).toBe(413);
  });

  it("rejects a 61 char pouch name with 400", async () => {
    const r = await app.request("/pouches", {
      method: "POST",
      headers: { ...json, ...auth },
      body: JSON.stringify({ name: "a".repeat(61), maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] }),
    });
    expect(r.status).toBe(400);
  });
});

describe("trusted proxy resolution", () => {
  it("uses forwarding information only from a trusted socket peer", async () => {
    const { clientIp } = await import("../src/security/rateLimit.js");
    const context = (remote: string, headers: Record<string,string>) => ({env:{incoming:{socket:{remoteAddress:remote}}},req:{header:(name:string)=>headers[name]}}) as unknown as import("hono").Context;
    process.env.TRUSTED_PROXY_IPS="127.0.0.1,10.0.0.2";
    try {
      expect(clientIp(context("198.51.100.1",{"x-forwarded-for":"1.1.1.1"}))).toBe("198.51.100.1");
      expect(clientIp(context("127.0.0.1",{"x-forwarded-for":"1.1.1.1, 198.51.100.2"}))).toBe("198.51.100.2");
      expect(clientIp(context("::ffff:127.0.0.1",{"x-forwarded-for":"198.51.100.3, 10.0.0.2"}))).toBe("198.51.100.3");
      expect(clientIp(context("127.0.0.1",{"x-forwarded-for":"malformed"}))).toBe("127.0.0.1");
    } finally { delete process.env.TRUSTED_PROXY_IPS; }
  });
});
