import { describe, expect, it } from "vitest";
import type { Order } from "@solpouch/shared";
import { readback } from "../src/routes/voice.js";

const line = (name: string, micros: number, estimated: boolean) => ({
  requested: name, requestedQty: 1, qty: 1, lineTotal: micros, matchScore: estimated ? 0.8 : 0.95, substitution: false,
  product: { id: `web:x.ca:${name}`, merchantId: "web:x.ca", name, unitPrice: micros, inStock: true, estimated },
});
const order = (lines: any[]): Order => ({ id: "o1", pouchId: "p1", merchantId: "web:x.ca", request: "r", lines, total: lines.reduce((s, l) => s + l.lineTotal, 0), status: "draft", createdAt: new Date(0).toISOString() }) as Order;

describe("voice readback", () => {
  it("says which prices are estimates", () => {
    const say = readback(order([line("Tenders Combo", 11_990_000, false), line("Biscuit", 1_990_000, true)]));
    expect(say).toContain("1 Tenders Combo, $11.99");
    expect(say).toContain("1 Biscuit, about $1.99, estimated");
  });
  it("calls a web order with no estimated line a plain total", () => {
    const say = readback(order([line("Tenders Combo", 11_990_000, false)]));
    expect(say).toContain("Total CAD $11.99.");
    expect(say).not.toMatch(/Estimated total|search estimate/);
    expect(say).toContain("checkout with the retailer");
    expect(readback(order([line("Biscuit", 1_990_000, true)]))).toMatch(/Estimated total CAD .*search estimate only/);
  });
});
