import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentPending } from "../src/vault/recovery.js";
import { VaultRejected } from "../src/vault/types.js";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { authHeaders, ownedSeed, sessionToken, voiceToken } from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ELEVENLABS_TOOL_SECRET;

const A = "a@example.com";
const B = "b@example.com";
const json = { "Content-Type": "application/json" };

let app: ReturnType<typeof createApp>;
let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore([...ownedSeed(A), ...ownedSeed(B).map((p) => ({ ...p, id: `b-${p.id}`, address: `b-${p.address}` }))]);
  const vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo, () => 1_000_000);
  app = createApp({
    store,
    vault,
    verifyGoogle: async (cred) => {
      if (cred !== "good") throw new Error("bad");
      return { email: "Alice@Example.com", name: "Alice", picture: "http://pic" };
    },
  });
});

const req = async (method: string, path: string, who: string | null, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...json, ...(who ? await authHeaders(store, who) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("google sign-in", () => {
  it("exchanges a verified credential for a session token", async () => {
    const res = await req("POST", "/auth/google", null, { credential: "good" });
    expect(res.status).toBe(200);
    const { token, user } = await res.json();
    expect(user).toEqual({ email: "alice@example.com", name: "Alice", picture: "http://pic" });
    const me = await app.request("/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("alice@example.com");
  });

  it("rejects bad credentials and oversized input", async () => {
    expect((await req("POST", "/auth/google", null, { credential: "nope" })).status).toBe(401);
    expect((await req("POST", "/auth/google", null, { credential: "x".repeat(4097) })).status).toBe(400);
  });

  it("issues a voice token only to signed-in users", async () => {
    expect((await req("POST", "/auth/voice-token", null)).status).toBe(401);
    const res = await req("POST", "/auth/voice-token", A);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeTruthy();
  });
});

describe("authentication", () => {
  it("401 sign_in_required without a token, public routes stay open", async () => {
    for (const p of ["/pouches", "/orders", "/stats/spend"]) {
      const r = await app.request(p);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "sign_in_required" });
    }
    expect((await app.request("/pouches", { headers: { Authorization: "Bearer garbage" } })).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/merchants")).status).toBe(200);
  });

  it("a voice token is not a session token", async () => {
    const r = await app.request("/pouches", { headers: { Authorization: `Bearer ${await voiceToken(store, A)}` } });
    expect(r.status).toBe(401);
  });
});

describe("per-user ownership", () => {
  it("lists only the caller's pouches", async () => {
    const a = (await (await req("GET", "/pouches", A)).json()) as { id: string }[];
    expect(a.map((p) => p.id).sort()).toEqual(["groceries", "kim-materials", "uber-eats"]);
    expect(JSON.stringify(a)).not.toContain("ownerEmail");
    const b = (await (await req("GET", "/pouches", B)).json()) as { id: string }[];
    expect(b.every((p) => p.id.startsWith("b-"))).toBe(true);
  });

  it("user A cannot read or modify user B's pouch", async () => {
    expect((await req("GET", "/pouches/b-uber-eats", A)).status).toBe(404);
    expect((await req("PATCH", "/pouches/b-uber-eats/rules", A, { dailyLimit: 1 })).status).toBe(404);
    expect((await req("POST", "/pouches/b-uber-eats/freeze", A)).status).toBe(404);
    expect((await req("POST", "/pouches/b-uber-eats/unfreeze", A)).status).toBe(404);
    expect((await req("POST", "/topups", A, { pouchId: "b-uber-eats", amount: 5, reason: "sneaky top-up" })).status).toBe(404);
    expect((await req("POST", "/orders", A, { request: "pad thai", pouchId: "b-uber-eats" })).status).toBe(404);
    expect((await store.getPouch("b-uber-eats"))!.frozen).toBe(false);
  });

  it("orders and top-ups are scoped through their pouch", async () => {
    const order = await (await req("POST", "/orders", B, { request: "pad thai" })).json();
    expect(order.pouchId.startsWith("b-")).toBe(true);
    expect((await req("GET", `/orders/${order.id}`, A)).status).toBe(404);
    expect((await req("POST", `/orders/${order.id}/confirm`, A)).status).toBe(404);
    expect((await req("POST", `/orders/${order.id}/cancel`, A)).status).toBe(404);
    expect(await (await req("GET", "/orders", A)).json()).toEqual([]);
    expect((await req("GET", `/orders?pouchId=${order.pouchId}`, A)).status).toBe(404);
    expect(((await (await req("GET", "/orders", B)).json()) as unknown[]).length).toBe(1);
    const t = await (await req("POST", "/topups", B, { pouchId: order.pouchId, amount: 5, reason: "dinner money" })).json();
    expect((await req("POST", `/topups/${t.id}/complete`, A)).status).toBe(404);
  });

  it("new pouches are owned by the creator", async () => {
    const res = await req("POST", "/pouches", A, { name: "Fun", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect((await store.getPouch(id))!.ownerEmail).toBe(A);
    expect((await req("GET", `/pouches/${id}`, B)).status).toBe(404);
  });

  it("the pouch cap is per user", async () => {
    for (let i = 0; i < 47; i++) {
      await store.savePouch({ ...(await store.getPouch("uber-eats"))!, id: `x${i}`, version: undefined, address: `addr${i}` });
    }
    const body = { name: "Over", maxPerOrder: 1, dailyLimit: 1, allowedMerchantIds: [] };
    expect((await req("POST", "/pouches", A, body)).status).toBe(409);
    expect((await req("POST", "/pouches", B, body)).status).toBe(201);
  });
});

describe("voice tools need a voice token", () => {
  const tool = (name: string, body: unknown) => app.request(`/voice/tools/${name}`, { method: "POST", headers: json, body: JSON.stringify(body) });

  it("rejects missing, garbage, and session tokens", async () => {
    for (const body of [{}, { user_token: "garbage" }, { user_token: await sessionToken(store, A) }]) {
      const r = await tool("get_pouches", body);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ say: "Please sign in to Solpouch first." });
    }
  });

  it("scopes tools to the token's user", async () => {
    const r = await (await tool("get_pouches", { user_token: await voiceToken(store, B) })).json();
    expect(r.pouches.every((p: { id: string }) => p.id.startsWith("b-"))).toBe(true);
    await tool("freeze_all", { user_token: await voiceToken(store, B) });
    expect((await store.getPouch("uber-eats"))!.frozen).toBe(false);
    expect((await store.getPouch("b-uber-eats"))!.frozen).toBe(true);
  });

  it("never tells the caller an unconfirmed payment was refused", async () => {
    const order = await (await req("POST", "/orders", A, { request: "pad thai" })).json();
    const pay = vi.spyOn(MockVaultClient.prototype, "pay").mockRejectedValueOnce(new PaymentPending());
    const r = await (await tool("confirm_order", { orderId: order.id, user_token: await voiceToken(store, A) })).json();
    pay.mockRestore();
    expect(r.status).toBe("paying");
    expect(r.code).toBe("PaymentPending");
    expect(r.say).not.toMatch(/refused|no money moved/i);
    expect((await store.getOrder(order.id))!.status).toBe("paying");
  });

  it("reports a chain refusal as refused and closes the order", async () => {
    const order = await (await req("POST", "/orders", A, { request: "pad thai" })).json();
    const pay = vi.spyOn(MockVaultClient.prototype, "pay").mockRejectedValueOnce(new VaultRejected("OverDailyLimit"));
    const r = await (await tool("confirm_order", { orderId: order.id, user_token: await voiceToken(store, A) })).json();
    pay.mockRestore();
    expect(r).toMatchObject({ status: "rejected", code: "OverDailyLimit" });
    expect((await store.getOrder(order.id))!).toMatchObject({ status: "rejected", rejectReason: "OverDailyLimit" });
  });

  it("cannot confirm another user's order", async () => {
    const order = await (await req("POST", "/orders", B, { request: "pad thai" })).json();
    const r = await tool("confirm_order", { orderId: order.id, user_token: await voiceToken(store, A) });
    expect(r.status).toBe(404);
    expect((await store.getOrder(order.id))!.status).toBe("draft");
  });
});
