import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { Pouch } from "@solpouch/shared";
import { mapAllowedKeys, mapError, resolveMerchantKeys } from "../src/vault/chain.js";
import { MOCK_CHECKOUT_PAY_TO, assertCheckoutPayTo, checkoutPayTo } from "../src/services/fulfillment.js";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { SyncedVaultClient } from "../src/vault/synced.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { reconcilePouches } from "../src/services/reconcile.js";
import { getMerchant } from "../src/merchants/index.js";

const codeOf = (e: unknown) => { try { mapError(e); } catch (x) { return (x as { code?: string }).code ?? "other"; } return "none"; };

describe("checkout wallet", () => {
  it("never permits the mock checkout placeholder in chain mode", () => {
    expect(checkoutPayTo("mock")).toBe(MOCK_CHECKOUT_PAY_TO);
    const prev = process.env.CHECKOUT_PAY_TO;
    delete process.env.CHECKOUT_PAY_TO;
    expect(() => assertCheckoutPayTo()).toThrow("Set CHECKOUT_PAY_TO");
    process.env.CHECKOUT_PAY_TO = "not-a-key";
    expect(() => assertCheckoutPayTo()).toThrow("valid Solana public key");
    process.env.CHECKOUT_PAY_TO = Keypair.generate().publicKey.toBase58();
    expect(assertCheckoutPayTo()).toBe(checkoutPayTo());
    if (prev === undefined) delete process.env.CHECKOUT_PAY_TO; else process.env.CHECKOUT_PAY_TO = prev;
  });
});

describe("mapError", () => {
  it("maps framework, lamport and token errors to terminal codes", () => {
    expect(codeOf({ error: { errorCode: { code: "ConstraintHasOne", number: 2001 } } })).toBe("AgentKeyMismatch");
    expect(codeOf(new Error("Error Code: AccountNotInitialized. Error Number: 3012."))).toBe("PouchNotOnChain");
    expect(codeOf(new Error("custom program error: 0x7d6"))).toBe("ChainRejected");
    expect(codeOf(new Error("Transfer: insufficient lamports 5, need 10 custom program error: 0x1"))).toBe("SignerOutOfSol");
    expect(codeOf(new Error("Transaction simulation failed: custom program error: 0x1"))).toBe("InsufficientFunds");
    expect(codeOf(new Error("Allocate: account already in use"))).toBe("OrderAlreadyUsed");
    expect(codeOf(new Error("rpc timeout"))).toBe("other");
  });
});

describe("merchantKeys", () => {
  it("dedupes and refuses more than 10", () => {
    const k = Keypair.generate().publicKey.toBase58();
    expect(resolveMerchantKeys([k, k, k])).toHaveLength(1);
    const many = Array.from({ length: 11 }, () => Keypair.generate().publicKey.toBase58());
    expect(() => resolveMerchantKeys(many)).toThrow("TooManyMerchants");
  });
});

describe("getState allowlist mapping", () => {
  const payToOf = (id: string) => getMerchant(id)?.payTo;
  const stored = (ids: string[]) => ({ id: "p", allowedMerchantIds: ids }) as Pouch;
  it("maps the checkout key via the stored pouch and skips unknown keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const co = checkoutPayTo();
    const thai = getMerchant("thai-express")!;
    expect(mapAllowedKeys([thai.payTo, co], payToOf, stored([]))).toEqual([]);
    expect(mapAllowedKeys([thai.payTo, co], payToOf, stored(["thai-express", "web:example.com"]))).toEqual(["thai-express", "web:example.com"]);
    expect(mapAllowedKeys([Keypair.generate().publicKey.toBase58()], payToOf, stored(["x"]))).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("resilient writes and listings", () => {
  it("freeze writes frozen even when refresh fails", async () => {
    const store = new MemoryStore(seedPouches());
    const vault = new MockVaultClient(store, payToOfNone);
    vi.spyOn(vault, "getBalance").mockRejectedValue(new Error("rpc"));
    const inner = { ...vault, freeze: async () => ({ txSignature: "x" }), getBalance: vault.getBalance, getState: async () => { throw new Error("rpc"); } } as unknown as MockVaultClient;
    await new SyncedVaultClient(inner, store).freeze("uber-eats");
    expect((await store.getPouch("uber-eats"))!.frozen).toBe(true);
  });
  it("reconcilePouches returns the stored row for a failing pouch", async () => {
    const store = new MemoryStore(seedPouches());
    const vault = new MockVaultClient(store, payToOfNone);
    Object.defineProperty(vault, "authorizedOwner", { value: "o" });
    vi.spyOn(vault, "getBalance").mockRejectedValue(new Error("rpc"));
    const rows = await reconcilePouches({ store, vault });
    expect(rows).toHaveLength((await store.listPouches()).length);
  });
});
const payToOfNone = () => undefined;
