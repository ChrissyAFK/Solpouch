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
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::1", "2002::1", "fec0::1", "::127.0.0.1", "not-an-ip", "198.18.0.1", "198.19.255.255", "192.0.0.8", "192.88.99.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("expands IPv6 fully before deciding", () => {
    for (const ip of ["::", "fec1::1", "febf::1", "fe80::1%eth0", "0:0:0:0:0:0:0:1", "ff02::1", "2001:db8::1", "::7f00:1", "0:0:0:0:0:ffff:a00:1", "::ffff:10.0.0.1", "[::1]", "fc00::1", "64:ff9b::808:808", "64:ff9b:1::1", "64:ff9b:1:ffff::1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["::ffff:5db8:d822", "::ffff:93.184.216.34", "2001:4860:4860::8888", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("jsonLdProducts / textHasPrice", () => {
  it("reads Product offers, including @graph and string prices", () => {
    expect(jsonLdProducts(ld("Deck Screws", "12.99", "CAD"))).toEqual([{ name: "Deck Screws", price: 12.99, currency: "CAD" }]);
    const graph = `<script type='application/ld+json'>${JSON.stringify({ "@graph": [{ "@type": ["Product"], name: "Milk 2L", offers: [{ price: 5.49 }] }] })}</script>`;
    expect(jsonLdProducts(graph)).toEqual([{ name: "Milk 2L", price: 5.49, currency: undefined }]);
    expect(jsonLdProducts("<script type=\"application/ld+json\">{broken</script>")).toEqual([]);
  });
  it("skips lowPrice offers with a different highPrice", () => {
    const priceRange = `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Deck Screws 3 inch 100 pack", offers: { "@type": "Offer", lowPrice: 9.99, highPrice: 49.99 } })}</script></html>`;
    expect(jsonLdProducts(priceRange)).toEqual([]);

    const priceSame = `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Deck Screws 3 inch 100 pack", offers: { "@type": "Offer", lowPrice: 9.99, highPrice: 9.99 } })}</script></html>`;
    expect(jsonLdProducts(priceSame)).toEqual([{ name: "Deck Screws 3 inch 100 pack", price: 9.99, currency: undefined }]);
  });
  it("needs the price near the product name", () => {
    expect(textHasPrice("Deck Screws 3 inch, 100 pack $12.99 each", "Deck Screws 3 inch", 12.99)).toBe(true);
    expect(textHasPrice("Deck Screws 3 inch " + "x".repeat(600) + " $12.99", "Deck Screws 3 inch", 12.99)).toBe(false);
    expect(textHasPrice("Garden hose $112.99", "Garden hose", 12.99)).toBe(false);
  });
  it("skips prices with currency markers before or after", () => {
    // Before: US$, USD, US, €, £
    expect(textHasPrice("Deck Screws 3 inch 100 pack US$12.99", "Deck Screws 3 inch", 12.99)).toBe(false);
    expect(textHasPrice("Deck Screws 3 inch 100 pack USD 12.99", "Deck Screws 3 inch", 12.99)).toBe(false);
    expect(textHasPrice("Deck Screws 3 inch 100 pack €12.99", "Deck Screws 3 inch", 12.99)).toBe(false);
    // After: USD, US, EUR, €
    expect(textHasPrice("Deck Screws 3 inch 100 pack 12.99 USD", "Deck Screws 3 inch", 12.99)).toBe(false);
    // Still work with $ and CA$
    expect(textHasPrice("Deck Screws 3 inch 100 pack $12.99", "Deck Screws 3 inch", 12.99)).toBe(true);
    expect(textHasPrice("Deck Screws 3 inch 100 pack CA$12.99", "Deck Screws 3 inch", 12.99)).toBe(true);
  });
  it("only treats a currency marker as a marker when it is not part of a longer word", () => {
    const has = (s: string) => textHasPrice(`Deck Screws 3 inch 100 pack ${s}`, "Deck Screws 3 inch", 12.99);
    for (const s of ["US$12.99", "US $12.99", "USD 12.99", "€12.99", "£12.99", "12.99 USD", "12.99 US", "12.99 EUR", "12.99 €", "12.99€"]) expect(has(s), s).toBe(false);
    for (const s of ["$12.99", "CA$12.99", "C$12.99", "CAD 12.99", "Plus $12.99", "Bonus $12.99", "Bonus 12.99", "Focus $12.99", "Menus $12.99", "Deck Screws Plus $12.99", "$12.99 used", "$12.99 USB cable", "$12.99 User reviews", "$12.99 usually", "$12.99 Europe"]) expect(has(s), s).toBe(true);
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
  it("uses JSON-LD price only if within 0.6x to 1.6x of searched price", async () => {
    // 49.99 is outside 0.6*12.99 to 1.6*12.99 range (7.794 to 20.784)
    const fetch = vi.fn(async () => page(ld("Deck Screws 1 inch 500 pack", 49.99, "CAD")));
    expect((await verifyPrice(item, "store.ca", { fetch, resolve: pub })).status).toBe("estimate");

    // 13.49 is within range
    const fetch2 = vi.fn(async () => page(ld("Deck Screws 3 inch (100 pack)", 13.49, "CAD")));
    expect(await verifyPrice(item, "store.ca", { fetch: fetch2, resolve: pub })).toEqual({ status: "verified", unitPrice: 13.49 });
  });
  const ldMany = (...ps: Array<[string, number, string?]>) =>
    `<html>${ps.map(([name, price, cur]) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", name, offers: { price, ...(cur ? { priceCurrency: cur } : {}) } })}</script>`).join("")}</html>`;
  const meal = { name: "Big Mac Meal", unitPrice: 11.99, url: "https://store.ca/p/bigmac" };
  it("does not confirm a meal at the price of the burger", async () => {
    const fetch = vi.fn(async () => page(ldMany(["Big Mac", 7.49, "CAD"])));
    expect(await verifyPrice(meal, "store.ca", { fetch, resolve: pub })).toEqual({ status: "estimate", reason: "price not found on the page" });
  });
  it("picks the product that has every word of the name", async () => {
    const fetch = vi.fn(async () => page(ldMany(["Big Mac", 7.49, "CAD"], ["Big Mac Meal", 12.29, "CAD"])));
    expect(await verifyPrice(meal, "store.ca", { fetch, resolve: pub })).toEqual({ status: "verified", unitPrice: 12.29 });
  });
  it("a product with no currency counts as CAD only for a Canadian-looking store", async () => {
    const html = ldMany(["Deck Screws 3 inch 100 pack", 12.99]);
    const com = { ...item, url: "https://store.com/p/deck-screws" };
    expect((await verifyPrice(com, "store.com", { fetch: vi.fn(async () => page(html)), resolve: pub })).status).toBe("estimate");
    expect((await verifyPrice({ ...item, url: "https://store.ca/p/deck-screws" }, "store.ca", { fetch: vi.fn(async () => page(html)), resolve: pub })).status).toBe("verified");
    expect((await verifyPrice({ ...item, url: "https://store.com/en-ca/p/deck-screws" }, "store.com", { fetch: vi.fn(async () => page(html)), resolve: pub })).status).toBe("verified");
    for (const u of ["https://store.com/us/ca/los-angeles/deck-screws", "https://store.com/p/ca-deck-screws", "https://store.com/stores/ca"])
      expect((await verifyPrice({ ...item, url: u }, "store.com", { fetch: vi.fn(async () => page(html)), resolve: pub })).status).toBe("estimate");
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
