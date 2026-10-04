import { describe, expect, it, vi } from "vitest";
import { isPrivateAddress, jsonLdProducts, textHasPrice, verifyPrice } from "../src/ai/verifyPrice.js";

const page = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
const pub = async () => ["93.184.216.34"];
const ld = (name: string, price: unknown, currency?: string) =>
  `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name, offers: { "@type": "Offer", price, ...(currency ? { priceCurrency: currency } : {}) } })}</script></html>`;
const item = { name: "Deck Screws 3 inch 100 pack", unitPrice: 12.99, url: "https://store.ca/p/deck-screws" };

describe("isPrivateAddress", () => {
  it("flags private, loopback and link-local; passes public", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("jsonLdProducts / textHasPrice", () => {
  it("reads Product offers, including @graph and string prices", () => {
    expect(jsonLdProducts(ld("Deck Screws", "12.99", "CAD"))).toEqual([{ name: "Deck Screws", price: 12.99, currency: "CAD" }]);
    const graph = `<script type='application/ld+json'>${JSON.stringify({ "@graph": [{ "@type": ["Product"], name: "Milk 2L", offers: [{ price: 5.49 }] }] })}</script>`;
    expect(jsonLdProducts(graph)).toEqual([{ name: "Milk 2L", price: 5.49, currency: undefined }]);
    expect(jsonLdProducts("<script type=\"application/ld+json\">{broken</script>")).toEqual([]);
  });
  it("needs the price near the product name", () => {
    expect(textHasPrice("Deck Screws 3 inch, 100 pack $12.99 each", "Deck Screws 3 inch", 12.99)).toBe(true);
    expect(textHasPrice("Deck Screws 3 inch " + "x".repeat(600) + " $12.99", "Deck Screws 3 inch", 12.99)).toBe(false);
    expect(textHasPrice("Garden hose $112.99", "Garden hose", 12.99)).toBe(false);
  });
});

describe("verifyPrice", () => {
  it("verifies from JSON-LD and takes the page price", async () => {
    const fetch = vi.fn(async () => page(ld("Deck Screws 3 inch (100 pack)", 13.49, "CAD")));
    expect(await verifyPrice(item, "store.ca", { fetch, resolve: pub })).toEqual({ status: "verified", unitPrice: 13.49 });
  });
  it("verifies from page text when there is no JSON-LD", async () => {
    const fetch = vi.fn(async () => page("<h1>Deck Screws 3 inch 100 pack</h1><span>$12.99</span>"));
    expect(await verifyPrice(item, "store.ca", { fetch, resolve: pub })).toEqual({ status: "verified", unitPrice: 12.99 });
  });
  it("is an estimate when the price is not on the page, the page fails, or there is no link", async () => {
    expect((await verifyPrice(item, "store.ca", { fetch: vi.fn(async () => page("<h1>Deck Screws 3 inch 100 pack</h1> $99.00")), resolve: pub })).status).toBe("estimate");
    expect((await verifyPrice(item, "store.ca", { fetch: vi.fn(async () => new Response("no", { status: 403 })), resolve: pub })).status).toBe("estimate");
    expect((await verifyPrice(item, "store.ca", { fetch: vi.fn(async () => { throw new Error("timeout"); }), resolve: pub })).status).toBe("estimate");
    expect((await verifyPrice({ ...item, url: undefined }, "store.ca", { resolve: pub })).status).toBe("estimate");
  });
  it("ignores a JSON-LD price in another currency", async () => {
    const fetch = vi.fn(async () => page(ld("Deck Screws 3 inch 100 pack", 9.49, "USD")));
    expect((await verifyPrice(item, "store.ca", { fetch, resolve: pub })).status).toBe("estimate");
  });
  it("never fetches a private address or another domain", async () => {
    const fetch = vi.fn(async () => page(ld("Deck Screws 3 inch 100 pack", 12.99)));
    expect((await verifyPrice(item, "store.ca", { fetch, resolve: async () => ["10.0.0.5"] })).status).toBe("estimate");
    expect((await verifyPrice({ ...item, url: "https://evil.com/p" }, "store.ca", { fetch, resolve: pub })).status).toBe("estimate");
    expect((await verifyPrice({ ...item, url: "http://store.ca/p" }, "store.ca", { fetch, resolve: pub })).status).toBe("estimate");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("follows a same-domain redirect and refuses one that leaves the domain", async () => {
    const hop = (to: string) => new Response(null, { status: 302, headers: { location: to } });
    const ok = vi.fn().mockResolvedValueOnce(hop("https://www.store.ca/p/deck-screws-2")).mockResolvedValueOnce(page(ld("Deck Screws 3 inch 100 pack", 12.99)));
    expect((await verifyPrice(item, "store.ca", { fetch: ok, resolve: pub })).status).toBe("verified");
    const bad = vi.fn().mockResolvedValueOnce(hop("https://evil.com/x"));
    expect((await verifyPrice(item, "store.ca", { fetch: bad, resolve: pub })).status).toBe("estimate");
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
