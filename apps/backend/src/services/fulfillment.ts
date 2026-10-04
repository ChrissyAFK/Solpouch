import { createInstacartList, InstacartError } from "./instacart.js";
import { PublicKey } from "@solana/web3.js";
import type { Order } from "@solpouch/shared";

/** Used only by the in-memory simulator; never passed to a chain client. */
export const MOCK_CHECKOUT_PAY_TO = "SoLCheckout111111111111111111111111111111111";
export class CheckoutConfigurationError extends Error {}

export function checkoutPayTo(mode = process.env.VAULT_MODE ?? "mock"): string {
  const configured = process.env.CHECKOUT_PAY_TO?.trim();
  if (!configured) {
    if (mode === "mock") return MOCK_CHECKOUT_PAY_TO;
    throw new CheckoutConfigurationError("Set CHECKOUT_PAY_TO to a valid Solana checkout wallet before using web or any-store pouches.");
  }
  try {
    return new PublicKey(configured).toBase58();
  } catch {
    throw new CheckoutConfigurationError("CHECKOUT_PAY_TO must be a valid Solana public key.");
  }
}

type Fulfillment = NonNullable<Order["fulfillment"]>;

export async function buildFulfillment(
  store: { name: string; url?: string },
  onInstacart: boolean,
  lines: { name: string; quantity: number }[],
): Promise<Fulfillment> {
  if (onInstacart) {
    try {
      return { via: "instacart", label: "Instacart shopping list", ...await createInstacartList(`Solpouch list from ${store.name}`, lines) };
    } catch (error) {
      return { via: "instacart", label: "Instacart shopping list", linkStatus: error instanceof InstacartError && error.code === "InstacartNotConfigured" ? "not_configured" : "unavailable" };
    }
  }
  return { via: "service", label: "Retailer checkout", checkoutUrl: store.url };
}

export function assertCheckoutPayTo(): string { return checkoutPayTo("chain"); }
