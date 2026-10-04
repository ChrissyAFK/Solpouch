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
    const s = ip.toLowerCase();
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
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
        const price = parseSinglePrice(o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price);
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
  const ld = jsonLdProducts(html).find((p) => nameMatches(c.name, p.name) && (!p.currency || p.currency.toUpperCase() === "CAD"));
  if (ld) return { status: "verified", unitPrice: ld.price };
  if (textHasPrice(pageText(html), c.name, c.unitPrice)) return { status: "verified", unitPrice: c.unitPrice };
  return { status: "estimate", reason: "price not found on the page" };
}
