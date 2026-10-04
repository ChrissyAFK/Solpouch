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
    const headers = { "Content-Type": "application/json", ...await authHeaders() };
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
      method: "POST", headers: { "Content-Type": "application/json", ...await authHeaders() },
      body: JSON.stringify({ name: "Web", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "CheckoutNotConfigured" });
    expect(await store.listPouches()).toEqual([]);
  });
});
