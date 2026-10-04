import { WEB_PREFIX, isAnyStore, type Pouch } from "@solpouch/shared";
import { merchants } from "../merchants/index.js";
import { checkoutPayTo } from "../services/fulfillment.js";

/** Wallet addresses a pouch may pay: web: entries and any-store map to the checkout wallet. */
export function allowedPayTos(p: Pouch, payToOf: (merchantId: string) => string | undefined): string[] {
  const list = isAnyStore(p)
    ? [...merchants.map((m) => m.payTo), checkoutPayTo()]
    : p.allowedMerchantIds.map((id) => (id.startsWith(WEB_PREFIX) ? checkoutPayTo() : payToOf(id)));
  return [...new Set(list.filter((s): s is string => !!s))];
}
