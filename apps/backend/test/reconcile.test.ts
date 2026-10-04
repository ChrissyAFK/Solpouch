import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { reconcilePouch } from "../src/services/reconcile.js";

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  store = new MemoryStore(seedPouches());
  vault = new MockVaultClient(store, () => undefined);
  Object.defineProperty(vault, "authorizedOwner", { value: "devnet-owner", configurable: true });
});

describe("read-only chain reconciliation", () => {
  it("repairs chain freeze and rules while preserving off-chain confirmation preferences", async () => {
    const previous = (await store.getPouch("uber-eats"))!;
    const state = { balance: 12, spentToday: 3, frozen: true, maxPerOrder: 7, dailyLimit: 15, allowedMerchantIds: ["mountain-market"] };
    const fullVault = Object.assign(vault, { getState: vi.fn().mockResolvedValue(state) });
    const balance = vi.spyOn(vault, "getBalance");
    const result = await reconcilePouch({ store, vault: fullVault }, "uber-eats");
    expect(result).toMatchObject(state);
    expect(result.confirmAbove).toBe(previous.confirmAbove);
    expect(result.name).toBe(previous.name);
    expect(balance).not.toHaveBeenCalled();
  });

  it("repairs stale balances without a chain mutation", async () => {
    vi.spyOn(vault, "getBalance").mockResolvedValue({ balance: 12, spentToday: 3 });
    const topup = vi.spyOn(vault, "topUp");
    const pay = vi.spyOn(vault, "pay");
    const create = vi.spyOn(vault, "createPouch");
    const result = await reconcilePouch({ store, vault }, "uber-eats");
    expect(result.balance).toBe(12);
    expect(result.spentToday).toBe(3);
    expect(await store.getPouch("uber-eats")).toEqual(result);
    expect(topup).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it("does not rewrite unchanged data", async () => {
    const save = vi.spyOn(store, "savePouch");
    await reconcilePouch({ store, vault }, "uber-eats");
    expect(save).not.toHaveBeenCalled();
  });
  it("reports unavailability instead of returning stale balances", async () => {
    vi.spyOn(vault, "getBalance").mockRejectedValue(new Error("RPC error"));
    await expect(reconcilePouch({ store, vault }, "uber-eats")).rejects.toMatchObject({ status: 503, message: "Unable to refresh this pouch. Try again." });
  });
  it("reports persistence failure and succeeds on a later read", async () => {
    vi.spyOn(vault, "getBalance").mockResolvedValue({ balance: 12, spentToday: 3 });
    const save = store.savePouch.bind(store);
    vi.spyOn(store, "savePouch").mockRejectedValueOnce(new Error("database down")).mockImplementation(save);
    await expect(reconcilePouch({ store, vault }, "uber-eats")).rejects.toMatchObject({ status: 503 });
    expect((await reconcilePouch({ store, vault }, "uber-eats")).balance).toBe(12);
  });
  it("does not query chain for missing or mock pouches", async () => {
    const read = vi.spyOn(vault, "getBalance");
    await expect(reconcilePouch({ store, vault }, "missing")).rejects.toMatchObject({ status: 404 });
    expect(read).not.toHaveBeenCalled();
    Object.defineProperty(vault, "authorizedOwner", { value: undefined });
    expect((await reconcilePouch({ store, vault }, "uber-eats")).id).toBe("uber-eats");
    expect(read).not.toHaveBeenCalled();
  });
});
