import { GoogleGenAI } from "@google/genai";
import type { ParsedItem } from "./gemini.js";

export interface WebFindItem {
  requested: string;
  name: string;
  brand?: string;
  size?: string;
  /** Unit price in CAD (treated 1:1 as USDC for the demo). */
  unitPrice: number;
  url?: string;
}
export interface WebFind {
  store: { name: string; domain: string; url?: string };
  onInstacart: boolean;
  items: WebFindItem[];
  /** True when the prices come from the offline fallback table. */
  fallback: boolean;
}

const model = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI | undefined {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return undefined;
  client ??= new GoogleGenAI({ apiKey: key });
  return client;
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

const PRICES: Array<[RegExp, number]> = [
  [/chainsaw/i, 299.99],
  [/orange juice/i, 5.49],
];

export function fallbackFind(items: ParsedItem[], allowedDomains?: string[]): WebFind {
  const domain = allowedDomains?.length ? normalizeDomain(allowedDomains[0]) : "example.com";
  return {
    store: { name: allowedDomains?.length ? domain : "Example Store", domain, url: `https://${domain}` },
    onInstacart: false,
    fallback: true,
    items: items.map((it) => ({
      requested: it.requested,
      name: it.requested,
      unitPrice: PRICES.find(([re]) => re.test(it.requested))?.[1] ?? 19.99,
      url: `https://${domain}/search?q=${encodeURIComponent(it.requested)}`,
    })),
  };
}

function parseJson(text: string): any {
  const t = text.replace(/```(?:json)?/gi, "").trim();
  const candidates = [t];
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}

export function validateFind(raw: any, items: ParsedItem[], allowedDomains?: string[]): WebFind | null {
  if (!raw || typeof raw !== "object") return null;
  const domain = normalizeDomain(String(raw.domain ?? raw.storeDomain ?? ""));
  const name = String(raw.storeName ?? raw.name ?? domain).trim();
  if (!domain || !domain.includes(".")) return null;
  if (allowedDomains?.length) {
    const ok = allowedDomains.map(normalizeDomain).some((d) => domain === d || domain.endsWith("." + d));
    if (!ok) return null;
  }
  const rawItems: any[] = Array.isArray(raw.items) ? raw.items : [];
  const out: WebFindItem[] = [];
  for (const [i, it] of items.entries()) {
    const m =
      rawItems.find((r) => String(r?.requested ?? "").toLowerCase() === it.requested.toLowerCase()) ?? rawItems[i];
    const price = Number(String(m?.unitPrice ?? m?.price ?? "").replace(/[^0-9.]/g, ""));
    if (!m || !Number.isFinite(price) || price <= 0) continue;
    out.push({
      requested: it.requested,
      name: String(m.name ?? m.product ?? it.requested),
      brand: m.brand ? String(m.brand) : undefined,
      size: m.size ? String(m.size) : undefined,
      unitPrice: Math.min(99999.99, Math.max(0.01, price)),
      url: typeof m.url === "string" && m.url.startsWith("http") ? m.url : undefined,
    });
  }
  if (!out.length) return null;
  const url = typeof raw.storeUrl === "string" && raw.storeUrl.startsWith("http") ? raw.storeUrl : `https://${domain}`;
  return { store: { name, domain, url }, onInstacart: raw.onInstacart === true, items: out, fallback: false };
}

/** Search the web (Gemini + Google Search grounding) for one retailer that sells the items. */
export async function findOnline(
  items: ParsedItem[],
  opts: { allowedDomains?: string[]; region?: string } = {},
): Promise<WebFind | null> {
  const g = ai();
  if (!g) return fallbackFind(items, opts.allowedDomains);
  const region = opts.region ?? "Vancouver, BC, Canada";
  const list = items.map((i) => `- ${i.requested} (qty ${i.qty})`).join("\n");
  const restrict = opts.allowedDomains?.length
    ? `The store MUST be one of these domains: ${opts.allowedDomains.join(", ")}.`
    : "Pick any real retailer.";
  const prompt = `Find ONE real online retailer that sells all (or most) of these items, preferring stores in Canada / ${region}:
${list}
${restrict}
Use Google Search to find real current prices. Reply with ONLY a JSON object, no prose, in this shape:
{"storeName": string, "domain": string, "storeUrl": string, "onInstacart": boolean,
 "items": [{"requested": string (exactly as listed above), "name": string, "brand": string|null, "size": string|null, "unitPrice": number (CAD, per unit), "url": string (product page)}]}
"onInstacart" is true only if this store is available on Instacart.`;
  try {
    const res = await g.models.generateContent({
      model: model(),
      contents: prompt,
      config: { tools: [{ googleSearch: {} }] },
    });
    return validateFind(parseJson(res.text ?? ""), items, opts.allowedDomains);
  } catch (e) {
    console.warn("findOnline failed, using fallback:", (e as Error).message);
    return fallbackFind(items, opts.allowedDomains);
  }
}
