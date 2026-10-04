import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { checkoutPayTo, CheckoutConfigurationError, MOCK_CHECKOUT_PAY_TO } from "../src/services/fulfillment.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { allowedPayTos } from "../src/vault/allow.js";
import { authHeaders, ownedSeed } from "./helpers.js";

afterEach(() => vi.unstubAllEnvs());

describe("checkout configuration", () => {
  it("keeps the placeholder exclusive to mock mode", () => {
    vi.stubEnv("CHECKOUT_PAY_TO", "");
    expect(checkoutPayTo("mock")).toBe(MOCK_CHECKOUT_PAY_TO);
    expect(() => checkoutPayTo("chain")).toThrow(CheckoutConfigurationError);
    expect(() => checkoutPayTo("chain")).toThrow("Set CHECKOUT_PAY_TO");
  });

  it("rejects malformed configured keys and accepts valid public keys", () => {
    vi.stubEnv("CHECKOUT_PAY_TO", MOCK_CHECKOUT_PAY_TO);
    expect(() => checkoutPayTo("chain")).toThrow("valid Solana public key");
    vi.stubEnv("CHECKOUT_PAY_TO", "  11111111111111111111111111111111  ");
    expect(new PublicKey(checkoutPayTo("chain")).toBase58()).toBe("11111111111111111111111111111111");
  });

  it("requires configuration for web and any-store chain rules, not catalog-only rules", () => {
    vi.stubEnv("CHECKOUT_PAY_TO", "");
    const p = ownedSeed()[0];
    expect(allowedPayTos({ ...p, allowedMerchantIds: ["catalog"] }, () => "catalog-wallet", () => checkoutPayTo("chain"))).toEqual(["catalog-wallet"]);
    for (const allowedMerchantIds of [["web:store.example"], []]) {
      expect(() => allowedPayTos({ ...p, allowedMerchantIds }, () => undefined, () => checkoutPayTo("chain"))).toThrow(CheckoutConfigurationError);
    }
  });
});

describe("chain-compatible pouch identifiers", () => {
  it("creates distinct 32-byte IDs independent of long or unicode display names", async () => {
    const store = new MemoryStore([]);
    const vault = new MockVaultClient(store, () => undefined);
    const create = vi.spyOn(vault, "createPouch");
    const app = createApp({ store, vault });
    const headers = { "Content-Type": "application/json", ...await authHeaders(store) };
    const ids = new Set<string>();
    for (const name of ["Vacation Savings", "x".repeat(60), "旅行 🏖️", "Vacation Savings"]) {
      const res = await app.request("/pouches", {
        method: "POST", headers,
        body: JSON.stringify({ name, maxPerOrder: 1_000_000, dailyLimit: 5_000_000, allowedMerchantIds: [] }),
      });
      expect(res.status).toBe(201);
      const pouch = await res.json();
      expect(pouch.name).toBe(name);
      expect(pouch.id).toMatch(/^[a-f0-9]{32}$/);
      expect(Buffer.byteLength(pouch.id)).toBe(32);
      ids.add(pouch.id);
    }
    expect(ids.size).toBe(4);
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("returns a clear error before saving a pouch when chain checkout configuration is missing", async () => {
    vi.stubEnv("CHECKOUT_PAY_TO", "");
    const store = new MemoryStore([]);
    const vault = new MockVaultClient(store, () => undefined);
    vi.spyOn(vault, "createPouch").mockImplementation(async () => {
      checkoutPayTo("chain");
      throw new Error("unreachable");
    });
    const app = createApp({ store, vault });
    const res = await app.request("/pouches", {
      method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders(store) },
      body: JSON.stringify({ name: "Web", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "CheckoutNotConfigured" });
    expect(await store.listPouches()).toEqual([]);
  });
});

describe("allowed merchant cap", () => {
  it("rejects more stores than the vault program can hold with a clear 422, on create and update", async () => {
    const store = new MemoryStore(ownedSeed());
    const vault = new MockVaultClient(store, () => undefined);
    const create = vi.spyOn(vault, "createPouch");
    const update = vi.spyOn(vault, "updateRules");
    const app = createApp({ store, vault });
    const headers = { "Content-Type": "application/json", ...await authHeaders(store) };
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `web:store${i}.example`);
    const tooMany = await app.request("/pouches", { method: "POST", headers, body: JSON.stringify({ name: "Many", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: ids(11) }) });
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toMatchObject({ code: "TooManyMerchants", error: expect.stringContaining("at most 10 stores") });
    expect(create).not.toHaveBeenCalled();
    const ok = await app.request("/pouches", { method: "POST", headers, body: JSON.stringify({ name: "Ten", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: ids(10) }) });
    expect(ok.status).toBe(201);
    const patch = await app.request("/pouches/uber-eats/rules", { method: "PATCH", headers, body: JSON.stringify({ allowedMerchantIds: ids(11) }) });
    expect(patch.status).toBe(422);
    expect(update).not.toHaveBeenCalled();
    expect((await store.getPouch("uber-eats"))!.allowedMerchantIds).toEqual(["thai-express"]);
  });
});

describe("pouch rules mirror the vault program's check_rules", () => {
  async function setup() {
    const store = new MemoryStore(ownedSeed());
    const vault = new MockVaultClient(store, () => undefined);
    const create = vi.spyOn(vault, "createPouch");
    const update = vi.spyOn(vault, "updateRules");
    const app = createApp({ store, vault });
    const headers = { "Content-Type": "application/json", ...await authHeaders(store) };
    return { store, vault, app, headers, create, update };
  }

  it("rejects zero limits, per-order above daily and duplicate stores on create with the program's codes", async () => {
    const { app, headers, create, store } = await setup();
    const before = (await store.listPouches()).length;
    const cases: [Record<string, unknown>, string][] = [
      [{ maxPerOrder: 0, dailyLimit: 5 }, "ZeroLimit"],
      [{ maxPerOrder: 5, dailyLimit: 0 }, "ZeroLimit"],
      [{ maxPerOrder: 6, dailyLimit: 5 }, "PerOrderOverDaily"],
      [{ maxPerOrder: 5, dailyLimit: 5, allowedMerchantIds: ["web:a.example", "web:a.example"] }, "DuplicateMerchant"],
    ];
    for (const [rules, code] of cases) {
      const res = await app.request("/pouches", { method: "POST", headers, body: JSON.stringify({ name: "P", allowedMerchantIds: [], ...rules }) });
      expect(res.status, code).toBe(422);
      expect(await res.json()).toMatchObject({ code });
    }
    expect(create).not.toHaveBeenCalled();
    expect((await store.listPouches()).length).toBe(before);
    const ok = await app.request("/pouches", { method: "POST", headers, body: JSON.stringify({ name: "P", maxPerOrder: 5, dailyLimit: 5, allowedMerchantIds: [] }) });
    expect(ok.status).toBe(201);
  });

  it("validates the merged rules on PATCH, so lowering only the daily limit below the per-order limit fails", async () => {
    const { app, headers, update, store } = await setup();
    // uber-eats: maxPerOrder 25, dailyLimit 40.
    const lower = await app.request("/pouches/uber-eats/rules", { method: "PATCH", headers, body: JSON.stringify({ dailyLimit: 10_000_000 }) });
    expect(lower.status).toBe(422);
    expect(await lower.json()).toMatchObject({ code: "PerOrderOverDaily" });
    const zero = await app.request("/pouches/uber-eats/rules", { method: "PATCH", headers, body: JSON.stringify({ maxPerOrder: 0 }) });
    expect(await zero.json()).toMatchObject({ code: "ZeroLimit" });
    const dup = await app.request("/pouches/uber-eats/rules", { method: "PATCH", headers, body: JSON.stringify({ allowedMerchantIds: ["thai-express", "thai-express"] }) });
    expect(await dup.json()).toMatchObject({ code: "DuplicateMerchant" });
    expect(update).not.toHaveBeenCalled();
    expect(await store.getPouch("uber-eats")).toMatchObject({ maxPerOrder: 25_000_000, dailyLimit: 40_000_000, allowedMerchantIds: ["thai-express"] });
    const both = await app.request("/pouches/uber-eats/rules", { method: "PATCH", headers, body: JSON.stringify({ maxPerOrder: 5_000_000, dailyLimit: 10_000_000 }) });
    expect(both.status).toBe(200);
  });

  it("MockVaultClient refuses invalid rules like the program does", async () => {
    const { vault, store } = await setup();
    const p = (await store.getPouch("uber-eats"))!;
    await expect(vault.createPouch({ ...p, maxPerOrder: 0 })).rejects.toMatchObject({ code: "ZeroLimit" });
    await expect(vault.updateRules({ ...p, maxPerOrder: p.dailyLimit + 1 })).rejects.toMatchObject({ code: "PerOrderOverDaily" });
    await expect(vault.updateRules({ ...p, allowedMerchantIds: ["x", "x"] })).rejects.toMatchObject({ code: "DuplicateMerchant" });
    await expect(vault.updateRules(p)).resolves.toMatchObject({ txSignature: expect.any(String) });
  });
});
