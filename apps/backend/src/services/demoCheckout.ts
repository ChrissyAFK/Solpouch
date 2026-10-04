import { isAnyStore, isCheckoutReference, orderCurrency, type Order, type OrderLine } from "@solpouch/shared";
import { checkoutPayTo } from "./fulfillment.js";
import { getOwnedOrder, getOwnedPouch, HttpError, type Deps } from "./orders.js";
import { validateOrderLines } from "./orderValidation.js";

export function demoRate(): string {
  const rate = process.env.FUNDING_USD_PER_CAD?.trim() ?? "";
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 2) throw new HttpError(503,"Configure the demo CAD conversion rate.","DemoUnavailable");
  return rate;
}
function converted(lines: OrderLine[], rate: string): OrderLine[] {
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6,"0"));
  return lines.map(line => {
    if (!line.product) return {...line};
    const price = (BigInt(line.product.unitPrice) * numerator + 500_000n) / 1_000_000n;
    if (price <= 0n || price > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(422,"Demo conversion amount is invalid.");
    return {...line,product:{...line.product,unitPrice:Number(price)},lineTotal:Number(price)*line.qty};
  });
}
export async function requireDemo(deps: Deps) {
  if (process.env.DEMO_RETAILER_PAYMENTS !== "1" || process.env.VAULT_MODE !== "chain" || !deps.vault.assertDevnet) throw new HttpError(503,"Demo checkout is not enabled. No retailer order is placed.","DemoUnavailable");
  await deps.vault.assertDevnet();
}
export async function validateDemoCheckout(deps: Deps, order: Order): Promise<string> {
  const demo = order.fulfillment?.demo;
  if (order.fulfillment?.via !== "demo" || !demo) throw new HttpError(422,"Missing demo quote.");
  await requireDemo(deps);
  if (demo.usdPerCad !== demoRate() || demo.payTo !== checkoutPayTo("chain")) throw new HttpError(409,"Demo configuration changed. Cancel and prepare a new quote.","RecordChanged");
  if (validateOrderLines(demo.sourceLines) !== demo.sourceTotal || JSON.stringify(converted(demo.sourceLines,demo.usdPerCad)) !== JSON.stringify(order.lines)) throw new HttpError(422,"Demo quote does not match its source estimate.");
  return demo.payTo;
}
export async function prepareDemoCheckout(deps: Deps, email: string, id: string, version: number): Promise<Order> {
  const initial = await getOwnedOrder(deps,id,email);
  return deps.store.withPouchLock(initial.pouchId,async()=>{
    const order = await getOwnedOrder(deps,id,email);
    if (order.status !== "draft" || order.version !== version) throw new HttpError(409,"This cart changed. Review it again.","RecordChanged");
    await requireDemo(deps);
    if (order.fulfillment?.via === "demo") { await validateDemoCheckout(deps,order); return order; }
    if (!isCheckoutReference(order) || orderCurrency(order) !== "CAD") throw new HttpError(422,"Only a retailer search estimate can become a demo quote.");
    const pouch = await getOwnedPouch(deps,order.pouchId,email);
    if (!isAnyStore(pouch) && !pouch.allowedMerchantIds.includes(order.merchantId)) throw new HttpError(422,"This pouch does not allow this store.","MerchantNotAllowed");
    const sourceTotal = validateOrderLines(order.lines);
    if (sourceTotal !== order.total || sourceTotal <= 0) throw new HttpError(422,"Invalid source estimate.");
    const usdPerCad = demoRate();
    const lines = converted(order.lines,usdPerCad);
    return deps.store.saveOrder({...order,lines,total:validateOrderLines(lines),fulfillment:{via:"demo",label:"Devnet demo checkout — no retailer order",demo:{sourceCurrency:"CAD",sourceTotal,sourceLines:order.lines,usdPerCad,payTo:checkoutPayTo("chain"),preparedAt:new Date().toISOString()}}});
  });
}
