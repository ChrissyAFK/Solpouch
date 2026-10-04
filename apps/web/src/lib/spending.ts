import type { Order, Pouch } from "@solpouch/shared";
import { isCheckoutReference } from "@solpouch/shared";
const DAY = 86_400_000;

/** History windows use UTC days. Remaining allowance uses the vault counter,
 * not an estimate reconstructed from possibly incomplete payment history. */
export function spendingSummary(pouches: Pouch[], orders: Order[], days: 7 | 30, now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY;
  const start = today - (days - 1) * DAY;
  const owned = new Set(pouches.map(p => p.id));
  const paid = orders.filter(o => owned.has(o.pouchId) && o.status === "paid" && !isCheckoutReference(o));
  const dated = paid.filter(o => o.paidAt && Number.isFinite(Date.parse(o.paidAt)) && Date.parse(o.paidAt) <= now);
  const selected = dated.filter(o => Date.parse(o.paidAt!) >= start);
  const prior = dated.filter(o => Date.parse(o.paidAt!) >= start - days * DAY && Date.parse(o.paidAt!) < start);
  const total = selected.reduce((sum,o) => sum + o.total, 0);
  const previous = prior.reduce((sum,o) => sum + o.total, 0);
  const rows = pouches.map(pouch => {
    const pouchOrders = selected.filter(o => o.pouchId === pouch.id);
    const todaySpent = pouch.spentToday;
    return {pouch, spent:pouchOrders.reduce((sum,o)=>sum+o.total,0), count:pouchOrders.length, todaySpent,
      remaining:Math.max(0,pouch.dailyLimit-todaySpent), available:pouch.frozen?0:Math.max(0,Math.min(pouch.balance,pouch.dailyLimit-todaySpent))};
  });
  return {total,previous,count:selected.length,undated:paid.length-dated.length,simulated:selected.filter(o=>o.txSignature?.startsWith("mock")).length,rows};
}
