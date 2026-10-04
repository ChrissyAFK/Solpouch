import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import type { Order, SpendPoint } from "@solpouch/shared";
import { MemoryStore, seedPouches } from "../src/store/memory.js";
import { ownedStore } from "../src/security/access.js";
import { statsRoutes } from "../src/routes/stats.js";
import { paymentsFromLogs } from "../src/indexer.js";
import idlJson from "../src/vault/idl/solpouch_vault.json" with { type: "json" };

const pay = (n: number, time: string, pouchId = "groceries", amount = 1000) =>
  ({ time, pouchId, merchantId: "m", orderId: "o" + n, amount, txSignature: "sig" + n });

describe("time-series store", () => {
  it("recordPayment is idempotent per txSignature", async () => {
    const s = new MemoryStore();
    await s.recordPayment(pay(1, "2026-01-01T10:00:00.000Z"));
    await s.recordPayment(pay(1, "2026-01-01T10:00:05.000Z"));
    expect(await s.spendSeries(["groceries"], "day", "1970-01-01T00:00:00.000Z")).toEqual([
      { bucket: "2026-01-01T00:00:00.000Z", pouchId: "groceries", spent: 1000, orders: 1 },
    ]);
  });

  it("spendSeries buckets by hour and day, filters pouches and since", async () => {
    const s = new MemoryStore();
    await s.recordPayment(pay(1, "2026-01-01T10:10:00.000Z"));
    await s.recordPayment(pay(2, "2026-01-01T10:50:00.000Z", "groceries", 500));
    await s.recordPayment(pay(3, "2026-01-01T11:00:00.000Z"));
    await s.recordPayment(pay(4, "2026-01-02T01:00:00.000Z"));
    await s.recordPayment(pay(5, "2026-01-01T10:00:00.000Z", "uber-eats"));
    const hours = await s.spendSeries(["groceries"], "hour", "1970-01-01T00:00:00.000Z");
    expect(hours.map((p) => [p.bucket, p.spent, p.orders])).toEqual([
      ["2026-01-01T10:00:00.000Z", 1500, 2],
      ["2026-01-01T11:00:00.000Z", 1000, 1],
      ["2026-01-02T01:00:00.000Z", 1000, 1],
    ]);
    const days = await s.spendSeries(["groceries"], "day", "2026-01-01T10:30:00.000Z");
    expect(days.map((p) => [p.bucket, p.spent, p.orders])).toEqual([
      ["2026-01-01T00:00:00.000Z", 1500, 2],
      ["2026-01-02T00:00:00.000Z", 1000, 1],
    ]);
  });
});

describe("GET /stats/spend", () => {
  const order = (id: string, pouchId: string, createdAt: string, total: number): Order =>
    ({ id, pouchId, merchantId: "m", request: "r", lines: [], total, status: "paid", txSignature: "s" + id, createdAt });

  async function setup() {
    const base = new MemoryStore(seedPouches().map((p, i) => ({ ...p, ownerEmail: i === 0 ? "b@x.io" : "a@x.io" })));
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("deps", { store: ownedStore(base, "a@x.io") } as never); await next(); });
    app.onError((e, c) => c.json({ error: e.message }, (e as { status?: number }).status as 404 ?? 500));
    app.route("/stats", statsRoutes({} as never));
    return { base, app };
  }
  const get = async (app: Hono, q = "") => (await app.request("/stats/spend" + q)).json() as Promise<SpendPoint[]>;

  it("falls back to paid orders when the table is empty", async () => {
    const { base, app } = await setup();
    await base.saveOrder(order("1", "groceries", "2026-01-01T10:10:00.000Z", 700));
    await base.saveOrder(order("2", "groceries", "2026-01-01T12:10:00.000Z", 300));
    expect(await get(app)).toEqual([{ bucket: "2026-01-01T00:00:00.000Z", pouchId: "groceries", spent: 1000, orders: 2 }]);
  });

  it("reads the series, scoped to the owner", async () => {
    const { base, app } = await setup();
    await base.recordPayment(pay(1, "2026-01-01T10:10:00.000Z"));
    await base.recordPayment(pay(2, "2026-01-01T10:10:00.000Z", "uber-eats"));
    expect(await get(app, "?bucket=hour")).toEqual([{ bucket: "2026-01-01T10:00:00.000Z", pouchId: "groceries", spent: 1000, orders: 1 }]);
    expect((await app.request("/stats/spend?pouchId=uber-eats")).status).toBe(404);
  });
});

describe("paymentsFromLogs", () => {
  it("decodes a PaymentMade event", () => {
    const idl = idlJson as unknown as Idl;
    const coder = new BorshCoder(idl);
    const programId = Keypair.generate().publicKey;
    const pouch = Keypair.generate().publicKey;
    const merchant = Keypair.generate().publicKey;
    const orderId = "00112233445566778899aabbccddeeff";
    // This anchor version has no events.encode: build discriminator + borsh layout by hand.
    const disc = (idl as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === "PaymentMade")!.discriminator;
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(12_340_000n);
    const time = Buffer.alloc(8); time.writeBigInt64LE(1_767_225_600n);
    const data = Buffer.concat([Buffer.from(disc), pouch.toBuffer(), merchant.toBuffer(), amount, Buffer.from(orderId, "hex"), time]);
    const logs = [
      `Program ${programId.toBase58()} invoke [1]`,
      "Program log: Instruction: Pay",
      `Program data: ${Buffer.from(data).toString("base64")}`,
      `Program ${programId.toBase58()} success`,
    ];
    expect(paymentsFromLogs(logs, "sigX", programId, coder)).toEqual([
      { signature: "sigX", pouch: pouch.toBase58(), merchant: merchant.toBase58(), amount: 12_340_000, orderId, time: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});
