import { PublicKey } from "@solana/web3.js";
import type { Order } from "@solpouch/shared";

/** Deterministic, valid (but keyless) checkout key for mock/offline use only. Override with CHECKOUT_PAY_TO. */
export const MOCK_CHECKOUT_PAY_TO = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1)).toBase58();
export const checkoutPayTo = () => process.env.CHECKOUT_PAY_TO?.trim() || MOCK_CHECKOUT_PAY_TO;

/** Chain mode must pay a real, configured checkout wallet. Throws when CHECKOUT_PAY_TO is unset or invalid. */
export function assertCheckoutPayTo(): string {
  const raw = process.env.CHECKOUT_PAY_TO?.trim();
  if (!raw) throw new Error("CHECKOUT_PAY_TO is not set. Chain mode needs the real checkout wallet public key.");
  try { return new PublicKey(raw).toBase58(); } catch { throw new Error("CHECKOUT_PAY_TO is not a valid Solana public key."); }
}

type Fulfillment = NonNullable<Order["fulfillment"]>;

async function instacartLink(title: string, names: { name: string; quantity: number }[]): Promise<string | undefined> {
  const key = process.env.INSTACART_API_KEY?.trim();
  if (!key) return undefined;
  const host = process.env.INSTACART_ENV === "dev" ? "connect.dev.instacart.tools" : "connect.instacart.com";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://${host}/idp/v1/products/products_link`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ title, line_items: names }),
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { products_link_url?: string };
    return body.products_link_url;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function buildFulfillment(
  store: { name: string; url?: string },
  onInstacart: boolean,
  lines: { name: string; quantity: number }[],
): Promise<Fulfillment> {
  if (onInstacart) {
    const fallback = `https://www.instacart.ca/store/s?k=${encodeURIComponent(lines.map((l) => l.name).join(" "))}`;
    const link = await instacartLink(`Solpouch order from ${store.name}`, lines);
    return { via: "instacart", label: "Instacart", checkoutUrl: link ?? fallback };
  }
  return { via: "service", label: "Solpouch Buyer", checkoutUrl: store.url };
}
