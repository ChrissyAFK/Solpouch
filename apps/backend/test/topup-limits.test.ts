import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, linkTestWallet, ownedSeed } from "./helpers.js";

const OTHER = "other@example.com";
const USDC = 1_000_000;
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
let otherAuth: Record<string, string>;

beforeEach(async () => {
  delete process.env.TOPUP_DAILY_LIMIT_USDC;
  delete process.env.TOPUP_COOLDOWN_SECONDS;
  store = new MemoryStore([...ownedSeed(), ...ownedSeed(OTHER).map((p) => ({ ...p, id: `o-${p.id}`, address: `o-${p.address}` }))]);
  app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
  auth = await authHeaders(store);
  otherAuth = await authHeaders(store, OTHER);
  await linkTestWallet(store);
  await linkTestWallet(store, OTHER);
});
afterEach(() => {
  delete process.env.TOPUP_DAILY_LIMIT_USDC;
  delete process.env.TOPUP_COOLDOWN_SECONDS;
});

const post = (headers: Record<string, string>, pouchId: string, amount: number) =>
  app.request("/topups", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: JSON.stringify({ pouchId, amount }) });

describe("top-up daily cap", () => {
  it("allows top-ups under the cap and rejects one crossing it, across pouches", async () => {
    const ids = (await store.listPouches("tester@example.com")).map((p) => p.id);
    expect((await post(auth, ids[0], 300 * USDC)).status).toBe(201);
    expect((await post(auth, ids[1], 150 * USDC)).status).toBe(201);
    const r = await post(auth, ids[0], 100 * USDC);
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(JSON.stringify(body)).toContain("$500 per 24 hours");
    expect(JSON.stringify(body)).toContain("TopUpLimit");
  });

  it("does not count cancelled top-ups, and other accounts are unaffected", async () => {
    const first = await (await post(auth, "uber-eats", 500 * USDC)).json();
    expect((await post(auth, "uber-eats", 1 * USDC)).status).toBe(429);
    expect((await post(otherAuth, "o-uber-eats", 500 * USDC)).status).toBe(201);
    await store.saveTopUp({ ...first, status: "cancelled" });
    expect((await post(auth, "uber-eats", 500 * USDC)).status).toBe(201);
  });

  it("returns 503 for an invalid daily limit", async () => {
    process.env.TOPUP_DAILY_LIMIT_USDC = "abc";
    expect((await post(auth, "uber-eats", USDC)).status).toBe(503);
  });
});

describe("top-up cooldown config", () => {
  it.each(["abc", "-5"])("returns 503 for invalid TOPUP_COOLDOWN_SECONDS=%s", async (v) => {
    process.env.TOPUP_COOLDOWN_SECONDS = v;
    expect((await post(auth, "uber-eats", USDC)).status).toBe(503);
  });
});

describe("genesis hash constants", () => {
  it("are full-length base58 hashes", () => {
    const b58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
    for (const [file, re] of [["../src/vault/ownerTransactions.ts", /DEVNET_GENESIS = "([^"]+)"/], ["../src/funding/verification.ts", /getGenesisHash\(\)\s*!==\s*'([^']+)'/]] as const) {
      const m = readFileSync(new URL(file, import.meta.url), "utf8").match(re);
      expect(m?.[1]).toMatch(b58);
    }
  });
});
