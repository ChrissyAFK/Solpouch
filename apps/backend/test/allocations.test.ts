import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import type { AllocationChain } from "../src/vault/allocationChain.js";
import { authHeaders, linkTestWallet, ownedSeed } from "./helpers.js";

const OTHER = "other@example.com";
const USDC = 1_000_000;
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let auth: Record<string, string>;
let otherAuth: Record<string, string>;
let moved: number; // what the fake chain reports as transferred
let pouchId: string;

const fakeChain: AllocationChain = {
  async buildTransfer({ allocationId }) { return { transaction: Buffer.from(`tx:${allocationId}`).toString("base64"), lastValidBlockHeight: 123 }; },
  async verifyTransfer({ amount }) { return moved === amount ? { ok: true } : { ok: false, reason: "Transferred amount does not match the allocation" }; },
};
const sig = (n: string) => `${n}`.padEnd(64, "x");

beforeEach(async () => {
  store = new MemoryStore([...ownedSeed(), ...ownedSeed(OTHER).map((p) => ({ ...p, id: `o-${p.id}`, address: `o-${p.address}` }))]);
  app = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo), allocationChain: fakeChain });
  auth = await authHeaders(store);
  otherAuth = await authHeaders(store, OTHER);
  pouchId = (await store.listPouches("tester@example.com"))[0].id;
  moved = 5 * USDC;
});

const post = (path: string, headers: Record<string, string>, body: unknown, a = app) =>
  a.request(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers }, body: JSON.stringify(body) });
const prepare = async (amount = 5 * USDC) => (await (await post("/allocations/prepare", auth, { pouchId, amount })).json()) as { allocationId: string; transaction: string; lastValidBlockHeight: number };

describe("allocations", () => {
  it("prepare requires a linked wallet", async () => {
    const r = await post("/allocations/prepare", auth, { pouchId, amount: 5 * USDC });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toContain("Link a wallet first");
  });

  it("prepare returns an unsigned transaction and complete credits the pouch", async () => {
    await linkTestWallet(store);
    const before = (await store.getPouch(pouchId))!.balance;
    const p = await prepare();
    expect(p.transaction).toBeTruthy();
    expect(p.lastValidBlockHeight).toBe(123);
    const r = await post(`/allocations/${p.allocationId}/complete`, auth, { signature: sig("a") });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ id: p.allocationId, status: "completed", amount: 5 * USDC, txSignature: sig("a") });
    expect(body.topUpSignature).toBeTruthy();
    expect(body.ownerEmail).toBeUndefined();
    expect((await store.getPouch(pouchId))!.balance).toBe(before + 5 * USDC);
  });

  it("rejects a reused signature", async () => {
    await linkTestWallet(store);
    const a = await prepare();
    const b = await prepare();
    expect((await post(`/allocations/${a.allocationId}/complete`, auth, { signature: sig("a") })).status).toBe(200);
    const r = await post(`/allocations/${b.allocationId}/complete`, auth, { signature: sig("a") });
    expect(r.status).toBe(422);
    expect((await store.getAllocation(b.allocationId))!.status).toBe("prepared");
  });

  it("rejects a wrong amount and stays prepared", async () => {
    await linkTestWallet(store);
    const a = await prepare();
    const before = (await store.getPouch(pouchId))!.balance;
    moved = 4 * USDC;
    const r = await post(`/allocations/${a.allocationId}/complete`, auth, { signature: sig("b") });
    expect(r.status).toBe(422);
    expect(JSON.stringify(await r.json())).toContain("does not match");
    expect((await store.getAllocation(a.allocationId))!.status).toBe("prepared");
    expect((await store.getPouch(pouchId))!.balance).toBe(before);
  });

  it("another user's allocation is 404", async () => {
    await linkTestWallet(store);
    const a = await prepare();
    const r = await post(`/allocations/${a.allocationId}/complete`, otherAuth, { signature: sig("c") });
    expect(r.status).toBe(404);
  });

  it("completing twice is idempotent", async () => {
    await linkTestWallet(store);
    const a = await prepare();
    const before = (await store.getPouch(pouchId))!.balance;
    const first = await (await post(`/allocations/${a.allocationId}/complete`, auth, { signature: sig("d") })).json();
    const second = await post(`/allocations/${a.allocationId}/complete`, auth, { signature: sig("d") });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
    expect((await store.getPouch(pouchId))!.balance).toBe(before + 5 * USDC);
  });

  it("returns 503 outside chain mode without an injected chain", async () => {
    await linkTestWallet(store);
    const plain = createApp({ store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo) });
    const r = await post("/allocations/prepare", auth, { pouchId, amount: USDC }, plain);
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).toContain("Wallet transfers need chain mode");
  });
});
