import { validQuantity } from "./orderValidation.js";

export class InstacartError extends Error {
  constructor(public code: "InstacartNotConfigured" | "InstacartUnavailable", message: string) { super(message); }
}
export function trustedInstacartUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return;
    if (!["instacart.com", "instacart.ca", "instacart.tools"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return;
    return url.href;
  } catch { return; }
}

/** Generates a shopping-list link, never charges funds or claims retailer fulfillment. */
export async function createInstacartList(title: string, lines: { name: string; quantity: number }[]) {
  const key = process.env.INSTACART_API_KEY?.trim();
  if (!key) throw new InstacartError("InstacartNotConfigured", "Instacart checkout links are not configured yet.");
  const environment = process.env.INSTACART_ENV ?? "dev";
  if (!["dev", "production"].includes(environment)) throw new InstacartError("InstacartNotConfigured", "Instacart checkout links are not configured correctly.");
  if (!lines.length || lines.length > 100) throw new InstacartError("InstacartUnavailable", "Choose between 1 and 100 items for the shopping list.");
  const line_items = lines.map(line => ({ name: line.name.slice(0, 300), line_item_measurements: [{ quantity: validQuantity(line.quantity), unit: "each" }] }));
  const host = environment === "dev" ? "connect.dev.instacart.tools" : "connect.instacart.com";
  try {
    const res = await fetch(`https://${host}/idp/v1/products/products_link`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ title: title.slice(0, 200), link_type: "shopping_list", expires_in: 7, line_items }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!res.ok) throw new Error("provider unavailable");
    const body = await res.json() as { products_link_url?: unknown };
    const checkoutUrl = trustedInstacartUrl(body.products_link_url);
    if (!checkoutUrl) throw new Error("invalid checkout URL");
    const now = Date.now();
    return { checkoutUrl, linkStatus: "ready" as const, linkCreatedAt: new Date(now).toISOString(), linkExpiresAt: new Date(now + 7 * 86400_000).toISOString() };
  } catch {
    throw new InstacartError("InstacartUnavailable", "Instacart could not prepare this shopping list. No purchase was made. Try again shortly.");
  }
}
