import { describe, expect, it } from "vitest";
import type { Order, Pouch, TopUp } from "@solpouch/shared";
import { PostgresStore } from "../src/store/postgres.js";

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgresStore", () => {
  it("round-trips pouch, order with lines, topup", async () => {
    const store = await PostgresStore.connect(process.env.TEST_DATABASE_URL!, []);
    const id = `t-${Date.now()}`;
    const pouch: Pouch = {
      id, address: `addr-${id}`, name: "Test", balance: 5_000_000, maxPerOrder: 1_000_000, dailyLimit: 2_000_000,
      spentToday: 300_000, confirmAbove: 0, allowedMerchantIds: ["m1"], frozen: false,
    };
    const savedPouch = await store.savePouch(pouch);
    expect(savedPouch.version).toBe(1);
    expect(await store.getPouch(id)).toEqual(savedPouch);

    const order: Order = {
      id: `o-${id}`, pouchId: id, merchantId: "m1", request: "milk", total: 100_000, status: "draft",
      createdAt: new Date().toISOString(),
      lines: [{ requested: "milk", requestedQty: 1, product: null, qty: 1, lineTotal: 100_000, matchScore: 0.9, substitution: false }],
    };
    const savedOrder = await store.saveOrder(order);
    await store.saveOrder({ ...savedOrder, total: 200_000 });
    expect((await store.getOrder(order.id))?.total).toBe(200_000);
    expect((await store.listOrders(id))[0]!.lines).toEqual(order.lines);

    const topup: TopUp = {
      id: `u-${id}`, pouchId: id, amount: 1_000_000, reason: "r", status: "cooling_down",
      readyAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    };
    const savedTopUp = await store.saveTopUp(topup);
    expect(await store.getTopUp(topup.id)).toEqual(savedTopUp);
    await store.close();
  });
});
