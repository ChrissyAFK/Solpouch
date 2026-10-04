import { describe, expect, it } from "vitest";
import { toMicros } from "@solpouch/shared";
import { parseRequestConstraints } from "../src/services/request-constraints.js";

describe("parseRequestConstraints", () => {
  const caps: [string, number][] = [
    ["large eggs under $1", 1],
    ["milk below 5 dollars", 5],
    ["bread less than $3.50", 3.5],
    ["eggs max $10", 10],
    ["eggs no more than 4", 4],
    ["eggs at most $2", 2],
    ["eggs up to $5", 5],
    ["eggs for $1 or less", 1],
    ["eggs cheaper than $2", 2],
    ["groceries, budget of $20", 20],
    ["eggs <= $5", 5],
    ["eggs under 99 cents", 0.99],
    ["eggs $4 max", 4],
  ];
  it.each(caps)("%s", (text, usd) => {
    expect(parseRequestConstraints(text)).toEqual({ maxPrice: toMicros(usd), hasConstraint: true });
  });
  it.each(["cheapest eggs", "as cheap as possible", "only on sale items"])("flags unparseable limit: %s", (text) => {
    expect(parseRequestConstraints(text)).toEqual({ hasConstraint: true });
  });
  it.each(["2 dozen eggs", "eggs for 4 people", "large eggs", "up to 4 people eat eggs", "12 eggs and 2 milk", "get me up to 2 or 3 apples", "buy milk and eggs within 2 or 3 days", ""])("not a constraint: %s", (text) => {
    expect(parseRequestConstraints(text)).toEqual({ hasConstraint: false });
  });
});

describe("parseRequestConstraints: review cases", () => {
  it.each([
    "eggs under a dollar", "milk for less than two dollars", "bread under five dollars", "eggs under 1$",
    "eggs, price cap $2", "eggs, $3 limit", "eggs, nothing over $3", "don't spend more than $5 on eggs", "eggs 2 usdc max",
  ])("flags %s as constrained", (text) => {
    expect(parseRequestConstraints(text).hasConstraint).toBe(true);
  });
  it("reads a thousands separator and a decimal comma", () => {
    expect(parseRequestConstraints("a laptop under $1,000").maxPrice).toBe(1_000_000_000);
    expect(parseRequestConstraints("eggs under $1,50").maxPrice).toBe(1_500_000);
  });
  it("marks per-item caps", () => {
    expect(parseRequestConstraints("3 avocados under $1.50 each").perItem).toBe(true);
    expect(parseRequestConstraints("avocados under $5").perItem).toBeUndefined();
  });
  it("leaves a plain request unconstrained", () => {
    expect(parseRequestConstraints("a dozen large eggs").hasConstraint).toBe(false);
  });
});
