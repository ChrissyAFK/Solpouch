import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { payDueWithdrawals } from "../src/services/withdrawals.js";
import { authHeaders, linkTestWallet, ownedSeed, TEST_USER, voiceToken } from "./helpers.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { VaultRejected } from "../src/vault/types.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ELEVENLABS_TOOL_SECRET;

const thai = getMerchant("thai-express")!.payTo;
const builders = getMerchant("burnaby-builders")!.payTo;
const $ = toMicros;

let clock = Date.now();
let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(async () => {
  clock = Date.now();
  vi.spyOn(Date,"now").mockImplementation(()=>clock);
  store = new MemoryStore(ownedSeed());
  await linkTestWallet(store);
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => clock);
});

afterEach(()=>vi.restoreAllMocks());

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
  it("reused order id returns the existing result", async () => {
    await vault.pay(await uber(), thai, $(5), "o1");
    expect(await code(vault.pay(await uber(), thai, $(5), "o1"))).toBe("ok");
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
      headers: { "content-type": "application/json", ...(path.startsWith("/voice/") ? {} : await authHeaders(store)), ...headers },
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
    const paid = await (await post(app, `/orders/${order.id}/confirm`, {version:order.version})).json();
    expect(paid.status).toBe("paid");
    expect(paid.txSignature).toBeTruthy();
  });

  it("rejected order returns ApiError with code", async () => {
    const app = mk();
    const order = await (await post(app, "/orders", { request: "3 pad thai" })).json();
    const res = await post(app, `/orders/${order.id}/confirm`, {version:order.version});
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

  it("missing search configuration never invents a payable chainsaw quote", async () => {
    const before = (await store.getPouch("groceries"))!.balance;
    const res = await post(mk(), "/orders", { request: "a chainsaw", pouchId: "groceries" });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("SearchUnavailable");
    expect(await store.listOrders()).toEqual([]);
    expect((await store.getPouch("groceries"))!.balance).toBe(before);
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

  describe("withdrawals", () => {
    const start = (app: ReturnType<typeof mk>, amount: number) => post(app, "/withdrawals", { pouchId: "uber-eats", amount });
    let prior: string | undefined;
    beforeEach(() => { prior = process.env.WITHDRAW_HOLD_SECONDS; process.env.WITHDRAW_HOLD_SECONDS = "0"; });
    afterEach(() => { if (prior === undefined) delete process.env.WITHDRAW_HOLD_SECONDS; else process.env.WITHDRAW_HOLD_SECONDS = prior; });

    it("starts on hold, then refuses a second one", async () => {
      const app = mk();
      const res = await start(app, $(10));
      expect(res.status).toBe(201);
      expect((await res.json()).status).toBe("holding");
      const second = await start(app, $(5));
      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe("WithdrawalPending");
    });

    it("refuses over balance, frozen pouch and missing wallet", async () => {
      const app = mk();
      const over = await start(app, $(101));
      expect(over.status).toBe(409);
      expect((await over.json()).code).toBe("InsufficientFunds");
      await vault.freeze("uber-eats");
      const frozen = await start(app, $(1));
      expect(frozen.status).toBe(409);
      expect((await frozen.json()).code).toBe("PouchFrozen");
      await store.setWallet(TEST_USER, null); // unlink: the wallet is no longer saved through profile writes
      expect((await start(app, $(1))).status).toBe(403);
    });

    it("cancels a held withdrawal", async () => {
      const app = mk();
      const w = await (await start(app, $(10))).json();
      const res = await post(app, `/withdrawals/${w.id}/cancel`);
      expect((await res.json()).status).toBe("cancelled");
      expect((await post(app, `/withdrawals/${w.id}/cancel`)).status).toBe(409);
    });

    it("sweeper pays a due withdrawal and lowers the balance", async () => {
      const app = mk();
      const w = await (await start(app, $(10))).json();
      await payDueWithdrawals({ store, vault });
      const done = (await store.getWithdrawal(w.id))!;
      expect(done.status).toBe("completed");
      expect(done.txSignature).toBeTruthy();
      expect((await uber()).balance).toBe($(90));
    });

    it("held money cannot be spent by an order", async () => {
      const app = mk();
      process.env.WITHDRAW_HOLD_SECONDS = "3600";
      expect((await start(app, $(90))).status).toBe(201);
      const order = await (await post(app, "/orders", { request: "get me pad thai under $20" })).json();
      expect(order.total).toBe($(15.5));
      const res = await post(app, `/orders/${order.id}/confirm`, {version:order.version});
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("InsufficientFunds");
    });

    const makeProcessing = async (app: ReturnType<typeof mk>) => {
      const w = await (await start(app, $(10))).json();
      await store.saveWithdrawal({ ...(await store.getWithdrawal(w.id))!, status: "processing" });
      return w.id as string;
    };

    it("cancels a processing withdrawal that was never sent", async () => {
      const app = mk();
      const id = await makeProcessing(app);
      const res = await post(app, `/withdrawals/${id}/cancel`);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("cancelled");
    });

    it("a never-sent processing withdrawal fails WalletChanged if the wallet changed", async () => {
      const app = mk();
      const id = await makeProcessing(app);
      await store.setWallet(TEST_USER, null);
      await store.setWallet(TEST_USER, "other-wallet");
      await payDueWithdrawals({ store, vault });
      const w = (await store.getWithdrawal(id))!;
      expect(w.status).toBe("failed");
      expect(w.failReason).toBe("WalletChanged");
      expect((await uber()).balance).toBe($(100));
    });

    it("start subtracts paying orders from the available amount", async () => {
      const app = mk();
      const order = await (await post(app, "/orders", { request: "get me pad thai under $20" })).json();
      await store.saveOrder({ ...(await store.getOrder(order.id))!, status: "paying" });
      const over = await start(app, $(90));
      expect(over.status).toBe(409);
      expect((await over.json()).code).toBe("InsufficientFunds");
      expect((await start(app, $(80))).status).toBe(201);
    });

    it("another user cannot list or cancel it", async () => {
      const app = mk();
      const w = await (await start(app, $(10))).json();
      const other = await authHeaders(store, "other@example.com");
      expect([403, 404]).toContain((await app.request("/withdrawals?pouchId=uber-eats", { headers: other })).status);
      expect([403, 404]).toContain((await post(app, `/withdrawals/${w.id}/cancel`, undefined, other)).status);
      expect((await store.getWithdrawal(w.id))!.status).toBe("holding");
    });
  });

  it("pending top-ups list, complete, cancel, ownership", async () => {
    const app = mk();
    const get = async (path: string, email?: string) =>
      app.request(path, { headers: await authHeaders(store, email) });
    const a = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(5) })).json();
    const b = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(7), reason: "more" })).json();
    const list = await (await get("/topups?pouchId=uber-eats")).json();
    expect(list.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect((await get("/topups")).status).toBe(200);
    expect((await (await get("/topups")).json()).map((t:{id:string})=>t.id).sort()).toEqual([a.id,b.id].sort());
    expect(await (await get("/topups", "other@example.com")).json()).toEqual([]);
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
    const get = async (path: string) => app.request(path, { headers: await authHeaders(store) });
    const b = await (await post(app, "/topups", { pouchId: "uber-eats", amount: $(7), reason: "more" })).json();
    const otherCancel = await app.request(`/topups/${b.id}/cancel`, { method: "POST", headers: await authHeaders(store,"other@example.com") });
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
      expect((await post(app, `/voice/tools/${tool}`, { pouchId: "uber-eats", amount: 5, user_token: await voiceToken(store) })).status).toBe(404);
    }
    expect((await uber()).balance).toBe($(100));
    const r = await (await post(app, "/voice/tools/create_order", { request: "pad thai", user_token: await voiceToken(store) })).json();
    expect(r.say).toContain("Total");
    const f = await post(app, "/voice/tools/freeze_all", { user_token: await voiceToken(store) });
    expect(f.status).toBe(200);
    expect((await uber()).frozen).toBe(true);
  });

  it("POST /pouches/freeze-all freezes every pouch and returns them", async () => {
    const app = mk();
    const res = await post(app, "/pouches/freeze-all");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((p: { frozen: boolean }) => p.frozen)).toBe(true);
    expect((await uber()).frozen).toBe(true);
    // Idempotent: already-frozen pouches are skipped.
    expect((await post(app, "/pouches/freeze-all")).status).toBe(200);
  });

  it("voice secret is enforced when set", async () => {
    process.env.ELEVENLABS_TOOL_SECRET = "s3cret";
    try {
      const app = mk();
      expect((await post(app, "/voice/tools/get_pouches", { user_token: await voiceToken(store) })).status).toBe(401);
      expect((await post(app, "/voice/tools/get_pouches", { user_token: await voiceToken(store) }, { "X-Solpouch-Secret": "s3cret" })).status).toBe(200);
    } finally {
      delete process.env.ELEVENLABS_TOOL_SECRET;
    }
  });
});

it("spending is bucketed on payment completion, not the earlier draft date",async()=> {
  await store.saveOrder({id:"paid-date",pouchId:"uber-eats",merchantId:"thai-express",request:"fixture",lines:[],total:100,status:"paid",createdAt:"2026-01-01T01:00:00.000Z",paidAt:"2026-01-03T01:00:00.000Z"});
  const response=await createApp({store,vault}).request("/stats/spend?bucket=day",{headers:await authHeaders(store)});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{pouchId:"uber-eats",bucket:"2026-01-03T00:00:00.000Z",spent:100,orders:1}]);
});

it("keeps undated legacy payments out of date buckets",async()=> {
  await store.saveOrder({id:"legacy-paid",pouchId:"uber-eats",merchantId:"thai-express",request:"fixture",lines:[],total:100,status:"paid",createdAt:"2026-01-01T01:00:00.000Z"});
  const app=createApp({store,vault});
  const response=await app.request("/stats/spend?bucket=day",{headers:await authHeaders(store)});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([]);
  const orders=await app.request("/orders",{headers:await authHeaders(store)});
  expect((await orders.json()).map((o:{id:string})=>o.id)).toContain("legacy-paid");
});
