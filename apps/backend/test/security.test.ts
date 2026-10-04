import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { clientIp, rateLimit } from "../src/security/rateLimit.js";
import { authHeaders, ownedSeed } from "./helpers.js";

const VOICE_SECRET = "fixture-only-voice-secret";
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(async () => {
  auth = await authHeaders();
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("TRUSTED_PROXY_IPS", "");
  vi.stubEnv("VOICE_WEBHOOK_SECRET", VOICE_SECRET);
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => 1_000_000);
  app = createApp({ store, vault });
});
afterEach(() => vi.unstubAllEnvs());

const json = { "Content-Type": "application/json" };
const badTopup = (ip: string, target = app) => target.request("/topups", {
  method: "POST", headers: { ...json, ...auth, "x-forwarded-for": ip }, body: "{}",
});

describe("security", () => {
  it("returns 429 with Retry-After past the limit", async () => {
    for (let i = 0; i < 5; i++) expect((await badTopup("1.1.1.1")).status).toBe(400);
    const response = await badTopup("1.1.1.1");
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await response.json()).error).toMatch(/Too many requests/);
  });

  it("rotating supplied forwarding headers cannot reset a rate limit", async () => {
    for (let i = 0; i < 5; i++) expect((await badTopup(`2.2.2.${i + 1}`)).status).toBe(400);
    expect((await badTopup("3.3.3.3")).status).toBe(429);
  });

  it("shares rate-limit buckets between app instances using the same store", async () => {
    const second = createApp({ store, vault });
    for (let i = 0; i < 5; i++) await badTopup("2.2.2.2", i % 2 ? second : app);
    expect((await badTopup("9.9.9.9", second)).status).toBe(429);
  });

  it("trusts a single forwarded IP only when the real socket peer is allowlisted", async () => {
    vi.stubEnv("TRUSTED_PROXY_IPS", "127.0.0.1");
    const probe = new Hono();
    probe.get("/", (c) => c.json({ ip: clientIp(c) }));
    const socket = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress, remoteFamily: "IPv4" } } });
    const headers = { "x-forwarded-for": "8.8.8.8", "cf-connecting-ip": "4.4.4.4" };
    expect(await (await probe.request("/", { headers }, socket("10.0.0.1"))).json()).toEqual({ ip: "10.0.0.1" });
    expect(await (await probe.request("/", { headers }, socket("127.0.0.1"))).json()).toEqual({ ip: "8.8.8.8" });
    expect(await (await probe.request("/", { headers: { "x-forwarded-for": "8.8.8.8, 1.1.1.1" } }, socket("127.0.0.1"))).json()).toEqual({ ip: "127.0.0.1" });
  });

  it("keeps different actual peers in separate buckets", async () => {
    const probe = new Hono();
    probe.use("*", rateLimit({ store, max: 1, windowMs: 60_000, key: "peer-test" }));
    probe.get("/", (c) => c.text("ok"));
    const socket = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
    expect((await probe.request("/", {}, socket("10.0.0.1"))).status).toBe(200);
    expect((await probe.request("/", {}, socket("10.0.0.1"))).status).toBe(429);
    expect((await probe.request("/", {}, socket("10.0.0.2"))).status).toBe(200);
  });

  it("requires authentication regardless of tunnel headers and keeps health public", async () => {
    const headers = { "cf-connecting-ip": "9.9.9.9" };
    expect((await app.request("/pouches", { headers })).status).toBe(401);
    expect((await app.request("/health", { headers })).status).toBe(200);
    expect((await app.request("/pouches", { headers: { ...headers, ...auth } })).status).toBe(200);
  });

  it("CORS echoes allowed origins only", async () => {
    const ok = await app.request("/health", { headers: { Origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await app.request("/health", { headers: { Origin: "https://evil.com" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rate limits failed voice secrets without a spoof-header bypass", async () => {
    const call = (index: number, secret: string) => app.request("/voice/tools/get_pouches", {
      method: "POST", headers: { ...json, "x-forwarded-for": `4.4.4.${index}`, "X-Solpouch-Secret": secret }, body: "{}",
    });
    for (let i = 0; i < 30; i++) expect((await call(i, "wrong")).status).toBe(401);
    expect((await call(31, VOICE_SECRET)).status).toBe(429);
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await app.request("/pouches", { method: "POST", headers: { ...json, ...auth }, body: JSON.stringify({ name: "x".repeat(70_000) }) });
    expect(response.status).toBe(413);
  });

  it("rejects a 61 char pouch name with 400", async () => {
    const response = await app.request("/pouches", { method: "POST", headers: { ...json, ...auth },
      body: JSON.stringify({ name: "a".repeat(61), maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] }),
    });
    expect(response.status).toBe(400);
  });
});
