import { beforeEach, describe, expect, it, vi } from "vitest";

// The offline table stands in for a real web lookup here; production code refuses fallback results.
vi.mock("../src/ai/findOnline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/findOnline.js")>();
  return { ...actual, findOnline: async (...args: Parameters<typeof actual.findOnline>) => {
    const r = await actual.findOnline(...args);
    return r && { ...r, fallback: false };
  } };
});
import { toMicros } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { authHeaders, ownedSeed, TEST_USER, voiceToken } from "./helpers.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { VaultRejected } from "../src/vault/types.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const VOICE_SECRET = "fixture-only-voice-secret";
process.env.VOICE_WEBHOOK_SECRET = VOICE_SECRET;

const thai = getMerchant("thai-express")!.payTo;
const builders = getMerchant("burnaby-builders")!.payTo;
const $ = toMicros;

let clock = 1_000_000;
let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(async () => {
  clock = 1_000_000;
  store = new MemoryStore(ownedSeed());
  await store.saveUser({ email: TEST_USER, wallet: "linked-test-wallet", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => clock);
});

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof VaultRejected) return e.code;
    throw e;
  }
  return "ok";
}
const uber = async () => (await store.getPouch("uber-eats"))!;

describe("MockVaultClient rules", () => {
  it("happy path moves money", async () => {
    const r = await vault.pay(await uber(), thai, $(10), "o1");
    expect(r.txSignature).toBeTruthy();
    const p = await uber();
    expect(p.balance).toBe($(90));
    expect(p.spentToday).toBe($(10));
  });
  it("frozen", async () => {
    await vault.freeze("uber-eats");
    expect(await code(vault.pay(await uber(), thai, $(1), "o1"))).toBe("PouchFrozen");
  });
  it("merchant not allowed", async () => {
    expect(await code(vault.pay(await uber(), builders, $(1), "o1"))).toBe("MerchantNotAllowed");
  });
  it("over per order", async () => {
    expect(await code(vault.pay(await uber(), thai, $(26), "o1"))).toBe("OverPerOrderLimit");
  });
  it("over daily limit", async () => {
    await vault.pay(await uber(), thai, $(25), "o1");
    expect(await code(vault.pay(await uber(), thai, $(16), "o2"))).toBe("OverDailyLimit");
  });
  it("insufficient funds", async () => {
    const p = await uber();
    p.balance = $(5);
    await store.savePouch(p);
    expect(await code(vault.pay(p, thai, $(10), "o1"))).toBe("InsufficientFunds");
  });
  it("reused order id returns the original signature without another debit", async () => {
    const first = await vault.pay(await uber(), thai, $(5), "o1");
    const repeated = await vault.pay(await uber(), thai, $(5), "o1");
    expect(repeated.txSignature).toBe(first.txSignature);
    expect((await uber()).balance).toBe($(95));
  });
  it("rolls the day after 24h", async () => {
    await vault.pay(await uber(), thai, $(25), "o1");
    expect(await code(vault.pay(await uber(), thai, $(25), "o2"))).toBe("OverDailyLimit");
    clock += 24 * 3600 * 1000;
    expect(await code(vault.pay(await uber(), thai, $(25), "o3"))).toBe("ok");
    expect((await uber()).spentToday).toBe($(25));
  });
});

describe("HTTP flow", () => {
  const mk = () => createApp({ store, vault });
  const post = async (app: ReturnType<typeof mk>, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(path.startsWith("/voice/") ? { "X-Solpouch-Secret": VOICE_SECRET } : await authHeaders()), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("draft -> confirm -> paid", async () => {
    const app = mk();
    const res = await post(app, "/orders", { request: "get me pad thai under $20" });
    expect(res.status).toBe(201);
    const order = await res.json();
    expect(order.status).toBe("draft");
    expect(order.pouchId).toBe("uber-eats");
    expect(order.total).toBe($(15.5));
    const paid = await (await post(app, `/orders/${order.id}/confirm`)).json();
    expect(paid.status).toBe("paid");
    expect(paid.txSignature).toBeTruthy();
  });

  it("rejected order returns ApiError with code", async () => {
    const app = mk();
    const order = await (await post(app, "/orders", { request: "3 pad thai" })).json();
    const res = await post(app, `/orders/${order.id}/confirm`);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("OverPerOrderLimit");
    expect((await store.getOrder(order.id))!.status).toBe("rejected");
  });

  it("substitutes out-of-stock oat milk", async () => {
    const app = mk();
    const order = await (await post(app, "/orders", { request: "oat milk and eggs" })).json();
    expect(order.pouchId).toBe("groceries");
    expect(order.lines[0].substitution).toBe(true);
    expect(order.lines[1].substitution).toBe(false);
  });

  it("finds a chainsaw online on an any-store pouch, then pays the checkout wallet", async () => {
    const app = mk();
    const g = (await store.getPouch("groceries"))!;
    g.maxPerOrder = $(1000);
    g.dailyLimit = $(1000);
    g.balance = $(1000);
    await store.savePouch(g);
    const res = await post(app, "/orders", { request: "a chainsaw", pouchId: "groceries" });
    expect(res.status).toBe(201);
    const order = await res.json();
    expect(order.store.domain).toBe("example.com");
    expect(order.lines[0].product.estimated).toBe(true);
    expect(order.fulfillment.via).toBe("service");
    expect(order.total).toBe($(299.99));
    const paid = await (await post(app, `/orders/${order.id}/confirm`)).json();
    expect(paid.status).toBe("paid");
    expect(paid.txSignature).toBeTruthy();
  });

  it("prices orange juice from the offline fallback", async () => {
    const order = await (await post(mk(), "/orders", { request: "orange juice", pouchId: "groceries" })).json();
    expect(order.total).toBeGreaterThan(0);
  });

  it("restricted catalog-only pouch never searches the web", async () => {
    const res = await post(mk(), "/orders", { request: "a chainsaw", pouchId: "uber-eats" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("This pouch only allows");
  });

  it("top-up before cooldown fails, after succeeds", async () => {
    const app = mk();
    const t = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(20), reason: "dinner money" })).json();
    expect(t.status).toBe("cooling_down");
    const early = await post(app, `/topups/${t.id}/complete`);
    expect(early.status).toBe(409);
    expect((await uber()).balance).toBe($(100));
    const saved = (await store.getTopUp(t.id))!;
    saved.readyAt = new Date(Date.now() - 1000).toISOString();
    await store.saveTopUp(saved);
    expect((await post(app, `/topups/${t.id}/complete`)).status).toBe(200);
    expect((await uber()).balance).toBe($(120));
  });

  it("top-up reason is optional", async () => {
    const res = await post(mk(), "/topups", { pouchId: "uber-eats", amount: $(5) });
    expect(res.status).toBe(201);
    expect((await res.json()).reason).toBe("Top-up");
  });

  it("pending top-ups list, complete, cancel, ownership", async () => {
    const app = mk();
    const get = async (path: string, email?: string) =>
      app.request(path, { headers: await authHeaders(email) });
    const a = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(5) })).json();
    const b = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(7), reason: "more" })).json();
    const list = await (await get("/topups?pouchId=uber-eats")).json();
    expect(list.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect((await get("/topups")).status).toBe(400);
    expect((await get("/topups?pouchId=uber-eats", "other@example.com")).status).toBe(404);

    const saved = (await store.getTopUp(a.id))!;
    saved.readyAt = new Date(Date.now() - 1000).toISOString();
    await store.saveTopUp(saved);
    expect((await post(app, `/topups/${a.id}/complete`)).status).toBe(200);
    const after = await (await get("/topups?pouchId=uber-eats")).json();
    expect(after.map((t: { id: string }) => t.id)).toEqual([b.id]);
  });

  it("cancel top-up: owner only, then complete is 409", async () => {
    const app = mk();
    const get = async (path: string) => app.request(path, { headers: await authHeaders() });
    const b = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(7), reason: "more" })).json();
    const otherCancel = await app.request(`/topups/${b.id}/cancel`, { method: "POST", headers: await authHeaders("other@example.com") });
    expect(otherCancel.status).toBe(404);
    const c = await post(app, `/topups/${b.id}/cancel`);
    expect(c.status).toBe(200);
    expect((await c.json()).status).toBe("cancelled");
    expect((await post(app, `/topups/${b.id}/complete`)).status).toBe(409);
    expect(await (await get("/topups?pouchId=uber-eats")).json()).toEqual([]);
  });

  it("voice has no top-up tool and cannot move money outside confirm", async () => {
    const app = mk();
    for (const tool of ["top_up", "topup", "start_topup", "complete_topup", "pay"]) {
      expect((await post(app, `/voice/tools/${tool}`, { pouchId: "uber-eats", amount: 5, user_token: await voiceToken() })).status).toBe(404);
    }
    expect((await uber()).balance).toBe($(100));
    const r = await (await post(app, "/voice/tools/create_order", { request: "pad thai", user_token: await voiceToken() })).json();
    expect(r.say).toContain("Total");
    const f = await post(app, "/voice/tools/freeze_all", { user_token: await voiceToken() });
    expect(f.status).toBe(200);
    expect((await uber()).frozen).toBe(true);
  });

  it("voice requires the configured secret", async () => {
    const app = mk();
    const body = { user_token: await voiceToken() };
    expect((await post(app, "/voice/tools/get_pouches", body, { "X-Solpouch-Secret": "wrong" })).status).toBe(401);
    expect((await post(app, "/voice/tools/get_pouches", body)).status).toBe(200);
    delete process.env.VOICE_WEBHOOK_SECRET;
    try { expect((await post(app, "/voice/tools/get_pouches", body)).status).toBe(503); }
    finally { process.env.VOICE_WEBHOOK_SECRET = VOICE_SECRET; }
  });
});
