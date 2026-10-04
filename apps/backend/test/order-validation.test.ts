import { describe, expect, it } from "vitest";
import { fallbackParse } from "../src/ai/gemini.js";
import { OrderInputError, validateOrderLines, validQuantity } from "../src/services/orderValidation.js";
import type { OrderLine } from "@solpouch/shared";
const line = (changes: Partial<OrderLine> = {}): OrderLine => ({ requested: "eggs", requestedQty: 2, qty: 2, lineTotal: 10_000_000, matchScore: 1, substitution: false, product: { id: "eggs", merchantId: "store", name: "Eggs", unitPrice: 5_000_000, inStock: true }, ...changes });
describe("safe order amounts", () => {
  it.each([Infinity, NaN, -1, 0, 1.5, 10001, Number.MAX_SAFE_INTEGER])("rejects unsafe quantity %s", value => expect(() => validQuantity(value)).toThrow(OrderInputError));
  it("rejects excessive quantities in ordinary text", () => expect(() => fallbackParse("999999999999999999999999999999999999 eggs")).toThrow(OrderInputError));
  it("preserves valid quantity and exact micro amounts", () => {
    expect(fallbackParse("2 eggs").items[0].qty).toBe(2);
    expect(validateOrderLines([line()])).toBe(10_000_000);
  });
  it("rejects inconsistent totals, unavailable charges and excessive cart totals", () => {
    expect(() => validateOrderLines([line({ lineTotal: 1 })])).toThrow(OrderInputError);
    expect(() => validateOrderLines([line({ product: null })])).toThrow(OrderInputError);
    expect(() => validateOrderLines([line({ qty: 10000, lineTotal: 50_000_000_000 })])).toThrow(OrderInputError);
    expect(() => validateOrderLines(Array.from({length:101},()=>line()))).toThrow(OrderInputError);
  });
});
