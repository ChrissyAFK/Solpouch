import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { getMerchant } from "../src/merchants/index.js";
import { authHeaders, ownedSeed } from "./helpers.js";

describe("GET /withdrawals/config", () => {
  const saved = { hold: process.env.WITHDRAW_HOLD_SECONDS, mode: process.env.VAULT_MODE };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  beforeEach(() => { delete process.env.WITHDRAW_HOLD_SECONDS; delete process.env.VAULT_MODE; });
  afterEach(() => { restore("WITHDRAW_HOLD_SECONDS", saved.hold); restore("VAULT_MODE", saved.mode); });

  const setup = () => {
    const store = new MemoryStore(ownedSeed());
    const app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
    return { store, get: async () => app.request("/withdrawals/config", { headers: await authHeaders(store) }), app };
  };

  it("returns the default hold and the simulated flag in mock mode", async () => {
    const res = await setup().get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ holdSeconds: 604800, simulated: true });
  });

  it("returns a configured hold and simulated=false in chain mode", async () => {
    process.env.WITHDRAW_HOLD_SECONDS = "3600";
    process.env.VAULT_MODE = "chain";
    expect(await (await setup().get()).json()).toEqual({ holdSeconds: 3600, simulated: false });
  });

  it("returns the same error as the POST handler for an invalid value", async () => {
    process.env.WITHDRAW_HOLD_SECONDS = "abc";
    expect((await setup().get()).status).toBe(503);
  });

  it("requires authentication", async () => {
    expect((await setup().app.request("/withdrawals/config")).status).toBe(401);
  });
});
