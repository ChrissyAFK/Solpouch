// Payment indexer: mirrors the vault program's PaymentMade events into the Tiger Data `payments` table.
import { BorshCoder, EventParser, type Idl } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { Store } from "./store/types.js";

export interface DecodedPayment {
  signature: string;
  pouch: string;
  merchant: string;
  amount: number;
  /** 32 hex chars, which is also the app's order id. */
  orderId: string;
  /** ISO time from the on-chain clock. */
  time: string;
}

/** Pure decode step: program logs of one transaction to its PaymentMade events. */
export function paymentsFromLogs(logs: string[], signature: string, programId: PublicKey, coder: BorshCoder): DecodedPayment[] {
  const out: DecodedPayment[] = [];
  try {
    for (const ev of new EventParser(programId, coder).parseLogs(logs)) {
      if (ev.name !== "PaymentMade" && ev.name !== "paymentMade") continue;
      const d = ev.data as { pouch: PublicKey; merchant: PublicKey; amount: { toString(): string }; orderId?: number[]; order_id?: number[]; time: { toString(): string } };
      const order = d.orderId ?? d.order_id ?? [];
      out.push({
        signature,
        pouch: d.pouch.toBase58(),
        merchant: d.merchant.toBase58(),
        amount: Number(d.amount.toString()),
        orderId: Buffer.from(order).toString("hex"),
        time: new Date(Number(d.time.toString()) * 1000).toISOString(),
      });
    }
  } catch (e) {
    console.warn("indexer: could not parse logs for", signature, (e as Error).message);
  }
  return out;
}

/** Record one decoded payment if its pouch is known. Returns whether it was recorded. */
export async function recordDecoded(store: Store, p: DecodedPayment): Promise<boolean> {
  const pouch = (await store.listPouches()).find((x) => x.address === p.pouch);
  if (!pouch) return false;
  const order = await store.getOrder(p.orderId);
  await store.recordPayment({ time: p.time, pouchId: pouch.id, merchantId: order?.merchantId ?? p.merchant, orderId: p.orderId, amount: p.amount, txSignature: p.signature });
  return true;
}

export async function backfillPaidOrders(store: Store): Promise<number> {
  let n = 0;
  for (const o of await store.listOrders()) {
    if (o.status !== "paid" || !o.txSignature || !o.paidAt || !Number.isFinite(Date.parse(o.paidAt))) continue;
    try {
      await store.recordPayment({ time: o.paidAt, pouchId: o.pouchId, merchantId: o.merchantId, orderId: o.id, amount: o.total, txSignature: o.txSignature });
      n++;
    } catch (e) { console.warn("indexer: backfill failed for order", o.id, (e as Error).message); }
  }
  return n;
}

/** Starts backfill and the live log subscription. Returns a stop function. Never throws. */
export async function startIndexer(deps: { store: Store; connection: Connection; programId: PublicKey; idl: Idl }): Promise<() => Promise<void>> {
  const { store, connection, programId, idl } = deps;
  const coder = new BorshCoder(idl);
  try { await backfillPaidOrders(store); } catch (e) { console.warn("indexer: backfill failed:", (e as Error).message); }
  let subId: number | undefined;
  try {
    subId = connection.onLogs(programId, (res) => {
      if (res.err) return;
      void (async () => {
        try {
          for (const p of paymentsFromLogs(res.logs, res.signature, programId, coder)) await recordDecoded(store, p);
        } catch (e) { console.warn("indexer: event handling failed:", (e as Error).message); }
      })();
    }, "confirmed");
  } catch (e) { console.warn("indexer: could not subscribe to logs:", (e as Error).message); }
  return async () => {
    if (subId === undefined) return;
    try { await connection.removeOnLogsListener(subId); } catch { /* ignore */ }
    subId = undefined;
  };
}
