import type { OrderLine } from "@solpouch/shared";

export class OrderInputError extends Error {}
export const MAX_ITEM_QUANTITY = 10_000;
export const MAX_ORDER_TOTAL = 10_000_000_000;

export function validQuantity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ITEM_QUANTITY) {
    throw new OrderInputError(`Choose a whole-number quantity between 1 and ${MAX_ITEM_QUANTITY.toLocaleString("en-US")}.`);
  }
  return value;
}

/** Check persisted and AI-generated carts before they reach storage or a vault. */
export function validateOrderLines(lines: OrderLine[]): number {
  if (!Array.isArray(lines) || lines.length > 100) throw new OrderInputError("Use at most 100 items per order.");
  let total = 0;
  for (const line of lines) {
    validQuantity(line.requestedQty);
    if (!line.product) {
      if (line.qty !== 0 || line.lineTotal !== 0) throw new OrderInputError("An unavailable item cannot have a payable amount.");
      continue;
    }
    validQuantity(line.qty);
    const price = line.product.unitPrice;
    if (!Number.isSafeInteger(price) || price < 1) throw new OrderInputError("An item has an invalid price. Create a new cart.");
    const amount = price * line.qty;
    if (!Number.isSafeInteger(amount) || amount !== line.lineTotal || amount > MAX_ORDER_TOTAL) {
      throw new OrderInputError("This cart exceeds the supported order amount. Reduce its quantities.");
    }
    total += amount;
    if (!Number.isSafeInteger(total) || total > MAX_ORDER_TOTAL) throw new OrderInputError("This cart exceeds the supported order amount. Reduce its quantities.");
  }
  return total;
}
