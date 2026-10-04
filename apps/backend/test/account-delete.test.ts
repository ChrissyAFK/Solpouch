import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryFundingRepository } from "../src/funding/repository.js";
import { MemoryStore } from "../src/store/memory.js";
import { getMerchant } from "../src/merchants/index.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, ownedSeed } from "./helpers.js";

const A = "a@example.com";
const B = "b@example.com";
const now = new Date().toISOString();
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
const mkApp = () => createApp({
  store, vault: new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => 1_000_000), fundingRepository: new MemoryFundingRepository(),
  verifyGoogle: async () => ({ email: "A@Example.com", name: "A", picture: "" }),
});
const del = async (who: string) => app.request("/auth/account", { method: "DELETE", headers: await authHeaders(store, who) });
const emptyPouches = async (who: string) => { for (const p of await store.listPouches(who)) await store.savePouch({ ...p, balance: 0 }); };
const order = (id: string, pouchId: string, status: "paid" | "paying") => ({ id, pouchId, merchantId: "thai-express", request: "x", lines: [], total: 1, status, createdAt: now });

beforeEach(() => {
  store = new MemoryStore([...ownedSeed(A), ...ownedSeed(B).map((p) => ({ ...p, id: `b-${p.id}`, address: `b-${p.address}` }))]);
  app = mkApp();
});

describe("delete account", () => {
  it("removes everything for A and leaves B intact; the old token stops working", async () => {
    await emptyPouches(A);
    const mine = (await store.listPouches(A))[0]!;
    const theirs = (await store.listPouches(B))[0]!;
    await store.saveOrder(order("a-order", mine.id, "paid"));
    await store.saveOrder(order("b-order", theirs.id, "paid"));
    await store.setWallet(A, "wallet-a");
    await store.saveShoppingList({ id: "l1", ownerEmail: A, name: "n", items: [], version: undefined, createdAt: now, updatedAt: now } as never);
    const headers = await authHeaders(store, A);
    await authHeaders(store, B);
    const res = await app.request("/auth/account", { method: "DELETE", headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await store.listPouches(A)).toEqual([]);
    expect(await store.listOrders(mine.id)).toEqual([]);
    expect(await store.getUser(A)).toBeUndefined();
    expect(await store.listShoppingLists(A)).toEqual([]);
    expect(await store.listSessions(A)).toEqual([]);
    expect((await app.request("/auth/me", { headers })).status).toBe(401);
    expect((await store.listPouches(B)).length).toBe(3);
    expect((await store.listOrders(theirs.id)).length).toBe(1);
    expect((await store.listSessions(B)).length).toBeGreaterThan(0);
  });

  it("refuses with 409 while a pouch holds money", async () => {
    const res = await del(A);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("AccountNotEmpty");
    expect(body.blockers.length).toBeGreaterThan(0);
    expect((await store.listPouches(A)).length).toBe(3);
  });

  it("refuses while a withdrawal is holding, an order is paying or a top-up is in progress", async () => {
    await emptyPouches(A);
    const [p0, p1, p2] = await store.listPouches(A);
    await store.saveWithdrawal({ id: "w1", pouchId: p0!.id, amount: 1, reason: "x", toWallet: "w", status: "holding", readyAt: now, createdAt: now });
    await store.saveOrder(order("o1", p1!.id, "paying"));
    await store.saveTopUp({ id: "t1", pouchId: p2!.id, amount: 1, reason: "x", status: "processing", readyAt: now, createdAt: now });
    const res = await del(A);
    expect(res.status).toBe(409);
    expect((await res.json()).blockers).toHaveLength(3);
    expect((await store.listPouches(A)).length).toBe(3);
  });

  it("a new sign-in after deletion starts with a clean account", async () => {
    await emptyPouches(A);
    expect((await del(A)).status).toBe(200);
    const res = await app.request("/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: "any" }) });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const pouches = await app.request("/pouches", { headers: { Authorization: `Bearer ${token}` } });
    expect(await pouches.json()).toEqual([]);
    expect((await store.getUser(A))?.wallet).toBeUndefined();
  });

  it("requires sign-in", async () => {
    expect((await app.request("/auth/account", { method: "DELETE" })).status).toBe(401);
  });
});
