import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMicros, type Order } from "@solpouch/shared";
import { createApp } from "../src/app.js";
import { getMerchant } from "../src/merchants/index.js";
import { MemoryStore } from "../src/store/memory.js";
import { needsConfirmation } from "../src/services/orders.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { ownedSeed, TEST_USER, voiceToken } from "./helpers.js";

delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const SECRET = "fixture-only-voice-secret";
process.env.VOICE_WEBHOOK_SECRET = SECRET;
const $ = toMicros;
const iso = () => new Date().toISOString();

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(async () => {
  store = new MemoryStore(ownedSeed());
  await store.saveUser({ email: TEST_USER, wallet: "linked-test-wallet", createdAt: iso(), updatedAt: iso() });
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
const call = async (tool: string, body: object) =>
  createApp({ store, vault }).request(`/voice/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Solpouch-Secret": SECRET },
    body: JSON.stringify({ ...body, user_token: await voiceToken() }),
  });
const draft = (total: number): Order => ({ id: `o-${Math.random().toString(16).slice(2)}`, pouchId: "uber-eats", merchantId: "thai-express", request: "pad thai", lines: [], total, status: "draft", createdAt: iso() });

describe("needsConfirmation", () => {
  it("0 asks every order; N asks only above N", () => {
    expect(needsConfirmation({ confirmAbove: 0 }, 1)).toBe(true);
    expect(needsConfirmation({ confirmAbove: $(10) }, $(10))).toBe(false);
    expect(needsConfirmation({ confirmAbove: $(10) }, $(10) + 1)).toBe(true);
  });
});

describe("voice with confirmAbove", () => {
  it("create_order reports needsConfirmation and adds the ask-first sentence only when under the amount", async () => {
    const ask = await (await call("create_order", { request: "get me pad thai under $20", pouchId: "uber-eats" })).json();
    expect(ask.needsConfirmation).toBe(true);
    expect(ask.say).not.toContain("ask-first");
    const p = (await store.getPouch("uber-eats"))!;
    await store.savePouch({ ...p, confirmAbove: $(25) });
    const skip = await (await call("create_order", { request: "get me pad thai under $20", pouchId: "uber-eats" })).json();
    expect(skip.needsConfirmation).toBe(false);
    expect(skip.say).toContain("ask-first");
  });
  it("confirm_order skips the min-age guard only when no confirmation is needed", async () => {
    const o = await store.saveOrder(draft($(5)));
    expect((await (await call("confirm_order", { orderId: o.id })).json()).status).toBe("draft");
    const p = (await store.getPouch("uber-eats"))!;
    await store.savePouch({ ...p, confirmAbove: $(10) });
    expect((await (await call("confirm_order", { orderId: o.id })).json()).status).toBe("paid");
    const big = await store.saveOrder(draft($(20)));
    expect((await (await call("confirm_order", { orderId: big.id })).json()).status).toBe("draft");
  });
});

describe("rolling 24h spend window in the store", () => {
  it("MemoryStore reads zero once spentSince is 24h old, and stamps now when spend has no window", async () => {
    const p = (await store.getPouch("uber-eats"))!;
    const saved = await store.savePouch({ ...p, spentToday: $(5) });
    expect(saved.spentSince).toBeTruthy();
    expect((await store.getPouch("uber-eats"))!.spentToday).toBe($(5));
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 24 * 3600 * 1000 + 1000);
    expect((await store.getPouch("uber-eats"))!.spentToday).toBe(0);
    expect((await store.listPouches()).find((x) => x.id === "uber-eats")!.spentToday).toBe(0);
    vi.restoreAllMocks();
  });
  it("chain-reported spentSince is honoured on read", async () => {
    const p = (await store.getPouch("uber-eats"))!;
    await store.savePouch({ ...p, spentToday: $(7), spentSince: new Date(Date.now() - 25 * 3600 * 1000).toISOString() });
    expect((await store.getPouch("uber-eats"))!.spentToday).toBe(0);
  });
});
