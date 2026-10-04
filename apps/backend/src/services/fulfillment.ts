import type { Order } from "@solpouch/shared";

/** Placeholder Solpouch checkout wallet for demos. Override with CHECKOUT_PAY_TO. */
export const MOCK_CHECKOUT_PAY_TO = "SoLCheckout111111111111111111111111111111111";
export const checkoutPayTo = () => process.env.CHECKOUT_PAY_TO?.trim() || MOCK_CHECKOUT_PAY_TO;

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
