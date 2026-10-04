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
    const savedPouch = await store.savePouch({...pouch, ownerEmail:"postgres@example.com"});
    expect(await store.getPouch(id)).toEqual(savedPouch);
    expect(await store.listPouches("other@example.com")).not.toContainEqual(savedPouch);

    const order: Order = {
      id: `o-${id}`, pouchId: id, merchantId: "m1", request: "milk", total: 100_000, status: "pending" as Order["status"],
      createdAt: new Date().toISOString(),
      lines: [{ requested: "milk", requestedQty: 1, product: null, qty: 1, lineTotal: 100_000, matchScore: 0.9, substitution: false }],
    };
    const savedOrder = await store.saveOrder({...order,store:{name:"Fixture",domain:"fixture.example"},fulfillment:{via:"instacart",label:"Instacart",checkoutUrl:"https://www.instacart.com/fixture"},paidAt:new Date().toISOString()});
    await store.saveOrder({ ...savedOrder, total: 200_000 });
    const readOrder = (await store.getOrder(order.id))!;
    expect(readOrder.store).toEqual(savedOrder.store);
    expect(readOrder.fulfillment).toEqual(savedOrder.fulfillment);
    expect(readOrder.paidAt).toBe(savedOrder.paidAt);
    expect((await store.getOrder(order.id))?.total).toBe(200_000);
    expect((await store.listOrders(id))[0]!.lines).toEqual(order.lines);

    const topup: TopUp = {
      id: `u-${id}`, pouchId: id, amount: 1_000_000, reason: "r", status: "pending" as TopUp["status"],
      readyAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    };
    const savedTopup = await store.saveTopUp({...topup,completedAt:new Date().toISOString(),txSignature:"fixture"});
    expect(await store.getTopUp(topup.id)).toEqual(savedTopup);
    const session={id:`session-${id}`,email:"postgres@example.com",name:"Fixture",picture:"",createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
    await store.saveSession(session);
    expect(await store.getSession(session.id)).toEqual(session);
    expect(await store.listSessions(session.email)).toContainEqual(session);
    await store.deleteSessions(session.email);
    expect(await store.getSession(session.id)).toBeUndefined();
    await store.close();
  });

  it("records indexed vault events idempotently and serves spend from them", async () => {
    const store = await PostgresStore.connect(process.env.TEST_DATABASE_URL!, []);
    const id = `idx-${Date.now()}`;
    const time = new Date().toISOString();
    const events = [{ signature: id, eventIndex: 0, name: "PaymentMade", pouchAddress: `addr-${id}`, amount: 250, time, slot: 1, data: { amount: "250" } }];
    const payments = [{ txSignature: id, eventIndex: 0, time, pouchId: id, merchantId: null, orderId: "0".repeat(32), amount: 250 }];
    expect(await store.indexedSpend([id], "day")).toBeUndefined();
    expect(await store.recordVaultEvents(events, payments)).toBe(1);
    expect(await store.recordVaultEvents(events, payments)).toBe(0);
    const day = await store.indexedSpend([id], "day");
    expect(day).toHaveLength(1);
    expect(day![0]).toMatchObject({ pouchId: id, spent: 250, orders: 1 });
    expect((await store.indexedSpend([id], "hour"))![0]).toMatchObject({ spent: 250, orders: 1 });
    expect(await store.indexedOrderIds([id], ["0".repeat(32), "f".repeat(32)])).toEqual(new Set(["0".repeat(32)]));
    expect(await store.indexedOrderIds(["other"], ["0".repeat(32)])).toEqual(new Set());
    await store.saveIndexerCursor(`test-${id}`, { signature: id, slot: 5 });
    expect(await store.getIndexerCursor(`test-${id}`)).toEqual({ signature: id, slot: 5 });
    await store.close();
  });
});
