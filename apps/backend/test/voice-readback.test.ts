import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "@solpouch/shared";
import { readback } from "../src/routes/voice.js";

const line = (name: string, micros: number, estimated: boolean) => ({
  requested: name, requestedQty: 1, qty: 1, lineTotal: micros, matchScore: estimated ? 0.8 : 0.95, substitution: false,
  product: { id: `web:x.ca:${name}`, merchantId: "web:x.ca", name, unitPrice: micros, inStock: true, estimated },
});
const order = (lines: any[]): Order => ({ id: "o1", pouchId: "p1", merchantId: "web:x.ca", request: "r", lines, total: lines.reduce((s, l) => s + l.lineTotal, 0), status: "draft", createdAt: new Date(0).toISOString() }) as Order;

const saved = { d: process.env.DEMO_RETAILER_PAYMENTS, v: process.env.VAULT_MODE };
const setEnv = (on: boolean) => {
  if (on) { process.env.DEMO_RETAILER_PAYMENTS = "1"; process.env.VAULT_MODE = "chain"; }
  else { delete process.env.DEMO_RETAILER_PAYMENTS; delete process.env.VAULT_MODE; }
};
afterEach(() => {
  for (const [k, v] of [["DEMO_RETAILER_PAYMENTS", saved.d], ["VAULT_MODE", saved.v]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("voice readback", () => {
  it("lists the items with only the final price", () => {
    setEnv(false);
    const say = readback(order([line("Tenders Combo", 11_990_000, false), line("Biscuit", 1_990_000, true)]));
    expect(say).toContain("1 Tenders Combo; 1 Biscuit.");
    expect(say).toContain("Total $13.98.");
    expect(say).not.toMatch(/estimate/i);
    expect(say).not.toMatch(/\$11\.99|\$1\.99/);
  });
  it("keeps the retailer wording when checkout is not enabled", () => {
    setEnv(false);
    const say = readback(order([line("Tenders Combo", 11_990_000, false)]));
    expect(say).toContain("Total $11.99.");
    expect(say).not.toMatch(/Estimated total|search estimate/);
    expect(say).toContain("checkout with the retailer");
    expect(readback(order([line("Biscuit", 1_990_000, true)]))).not.toMatch(/estimate/i);
  });
  it("offers to pay from the pouch when checkout is enabled", () => {
    setEnv(true);
    const plain = readback(order([line("Tenders Combo", 11_990_000, false)]));
    expect(plain).toContain("Total $11.99. Want me to pay for it from your pouch?");
    expect(plain).not.toContain("retailer");
    const est = readback(order([line("Biscuit", 1_990_000, true)]));
    expect(est).toContain("Total $1.99. Want me to pay for it from your pouch?");
    expect(est).not.toMatch(/estimate/i);
  });
  it("asks for approval without reading the cart again or wallet or rate jargon", () => {
    setEnv(true);
    const o = order([line("Biscuit", 1_450_000, false)]);
    o.fulfillment = { via: "demo", demo: { sourceTotal: 1_990_000, usdPerCad: 0.73, payTo: "Wallet123" } } as any;
    const say = readback(o);
    expect(say).toBe("Do you approve this payment of $1.99 from your pouch?");
    expect(say).not.toMatch(/Wallet123|USDC|per CAD/);
  });
});
