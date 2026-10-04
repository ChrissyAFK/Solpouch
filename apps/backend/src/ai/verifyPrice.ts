import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseSinglePrice, safeUrlForDomain } from "./findOnline.js";

export type PriceCheck = { status: "verified"; unitPrice: number } | { status: "estimate"; reason: string };
export interface VerifyDeps {
  fetch?: typeof fetch;
  /** Resolve a hostname to its IP addresses (tests inject this). */
  resolve?: (host: string) => Promise<string[]>;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 3000;
const MAX_HOPS = 3;

/** True for anything that is not a public unicast address (unparseable input counts as private). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const tail = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (tail) {
      const o = tail.slice(2).map(Number);
      if (o.some((n) => n > 255)) return true;
      s = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const halves = s.split("::");
    if (halves.length > 2) return true;
    const parse = (p: string) => (p === "" ? [] : p.split(":"));
    const head = parse(halves[0]);
    const rest = halves.length === 2 ? parse(halves[1]) : [];
    let parts: string[];
    if (halves.length === 2) {
      const fill = 8 - head.length - rest.length;
      if (fill < 1) return true;
      parts = [...head, ...Array<string>(fill).fill("0"), ...rest];
    } else parts = head;
    if (parts.length !== 8 || !parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return true;
    const g = parts.map((p) => parseInt(p, 16));
    const firstSixZero = g.slice(0, 6).every((x) => x === 0);
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && (g[6] !== 0 || g[7] > 1)))) {
      return isPrivateAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    if (firstSixZero && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xff80) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00 ||
      g[0] === 0x2002 || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) || (g[0] === 0x2001 && g[1] === 0xdb8);
  }
  return true;
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1);
/** At least half of the wanted name's words appear in the other text. */
function nameMatches(want: string, got: string): boolean {
  const w = tokens(want);
  if (!w.length) return false;
  const g = new Set(tokens(got));
  return w.filter((t) => g.has(t)).length / w.length >= 0.5;
}

/** schema.org Product / MenuItem offers found in the page's JSON-LD blocks. */
export function jsonLdProducts(html: string): Array<{ name: string; price: number; currency?: string }> {
  const out: Array<{ name: string; price: number; currency?: string }> = [];
  const walk = (n: any, depth: number) => {
    if (!n || typeof n !== "object" || depth > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, depth + 1));
    const types = ([] as string[]).concat(n["@type"] ?? []);
    if ((types.includes("Product") || types.includes("MenuItem")) && typeof n.name === "string") {
      for (const o of ([] as any[]).concat(n.offers ?? [])) {
        let price = parseSinglePrice(o?.price);
        if (!Number.isFinite(price)) {
          const lowPrice = parseSinglePrice(o?.lowPrice);
          if (Number.isFinite(lowPrice)) {
            const highPrice = parseSinglePrice(o?.highPrice);
            // Use lowPrice only if highPrice doesn't exist or is the same
            if (!Number.isFinite(highPrice) || highPrice === lowPrice) {
              price = lowPrice;
            }
          }
        }
        if (!Number.isFinite(price)) {
          price = parseSinglePrice(o?.priceSpecification?.price);
        }
        const currency = o?.priceCurrency ?? o?.priceSpecification?.priceCurrency;
        if (Number.isFinite(price) && price > 0) out.push({ name: n.name, price, currency: typeof currency === "string" ? currency : undefined });
      }
    }
    for (const v of Object.values(n)) walk(v, depth + 1);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()), 0);
    } catch {
      /* not JSON: skip this block */
    }
  }
  return out;
}

function pageText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

/** The exact price appears within 300 characters of at least half of the product name's words. */
export function textHasPrice(text: string, name: string, price: number): boolean {
  const want = tokens(name);
  if (!want.length) return false;
  const lower = text.toLowerCase();
  const re = new RegExp(`(?<![\\d.,])${price.toFixed(2).replace(".", "[.,]")}(?!\\d)`, "g");
  for (const m of lower.matchAll(re)) {
    // Skip if price has currency marker before it (US$, USD, US, €, £)
    const beforeText = lower.slice(Math.max(0, m.index - 8), m.index);
    if (/(?<![a-z])(?:us\$|usd|us|€|£)\s*\$?\s*$/.test(beforeText)) continue;
    // Skip if price has currency marker after it (USD, US, EUR, €)
    const afterText = lower.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (/^\s*(?:(?:usd|us|eur)\b|€)/.test(afterText)) continue;

    const near = new Set(tokens(lower.slice(Math.max(0, m.index - 300), m.index + 300)));
    if (want.filter((t) => near.has(t)).length / want.length >= 0.5) return true;
  }
  return false;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

// Known limit: fetch resolves the name again itself, so a DNS answer that changes between our check and the request is not caught. The body is only searched for a price and never returned to the caller.
/** GET an https page on `domain` (or a subdomain). Every hop is re-checked; null on anything unsafe or unreadable. */
async function fetchPage(url: string, domain: string, deps: VerifyDeps, signal: AbortSignal): Promise<string | null> {
  const doFetch = deps.fetch ?? fetch;
  const resolve = deps.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const safe = safeUrlForDomain(current, domain);
    if (!safe) return null;
    const addrs = await resolve(new URL(safe).hostname).catch(() => [] as string[]);
    if (!addrs.length || addrs.some(isPrivateAddress)) return null;
    const res = await doFetch(safe, {
      redirect: "manual",
      signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-CA,en;q=0.9" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      current = new URL(loc, safe).toString();
      continue;
    }
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) return null;
    return readCapped(res);
  }
  return null;
}

/** Confirm a searched price against the product's own page. Never throws. */
export async function verifyPrice(c: { name: string; unitPrice: number; url?: string }, domain: string, deps: VerifyDeps = {}): Promise<PriceCheck> {
  if (!c.url) return { status: "estimate", reason: "no product link" };
  let html: string | null = null;
  try {
    html = await fetchPage(c.url, domain, deps, AbortSignal.timeout(TIMEOUT_MS));
  } catch {
    html = null;
  }
  if (!html) return { status: "estimate", reason: "page could not be read" };
  const ld = jsonLdProducts(html).find((p) => nameMatches(c.name, p.name) && (!p.currency || p.currency.toUpperCase() === "CAD") && p.price >= c.unitPrice * 0.6 && p.price <= c.unitPrice * 1.6);
  if (ld) return { status: "verified", unitPrice: ld.price };
  if (textHasPrice(pageText(html), c.name, c.unitPrice)) return { status: "verified", unitPrice: c.unitPrice };
  return { status: "estimate", reason: "price not found on the page" };
}
