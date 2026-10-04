import { GoogleGenAI } from "@google/genai";
import type { ParsedItem } from "./gemini.js";
import { aiProvider, claude, claudeModel } from "./provider.js";
import { SearchUnavailableError, storeMatches } from "./storeMatch.js";

export { SearchUnavailableError };

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

/** True for a plain DNS hostname: no scheme, path, port, credentials, spaces or IP literal. */
export function isPlainHostname(raw: string): boolean {
  const h = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;
  return /[a-z]/.test(h.slice(h.lastIndexOf(".") + 1)); // numeric TLD means an IPv4 literal
}

/** Accept a model-supplied URL only if it is https and on `domain` or a subdomain of it. */
export function safeUrlForDomain(raw: unknown, domain: string): string | undefined {
  if (typeof raw !== "string" || !isPlainHostname(domain)) return undefined;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  const host = strip(u.hostname);
  const d = strip(domain.trim());
  return host === d || host.endsWith("." + d) ? u.toString() : undefined;
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

export function validateFind(raw: any, items: ParsedItem[], allowedDomains?: string[], want: { store?: string } = {}): WebFind | null {
  if (!raw || typeof raw !== "object") return null;
  const rawDomain = String(raw.domain ?? raw.storeDomain ?? "").trim();
  if (!isPlainHostname(rawDomain)) return null;
  const domain = normalizeDomain(rawDomain);
  const name = String(raw.storeName ?? raw.name ?? domain).trim();
  if (!domain || !domain.includes(".")) return null;
  // The user named a store: its own site or a delivery listing of it, never a look-alike from elsewhere.
  if (want.store && !storeMatches(want.store, name, domain)) return null;
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
      url: safeUrlForDomain(m.url, domain),
    });
  }
  if (!out.length) return null;
  const url = safeUrlForDomain(raw.storeUrl, domain) ?? `https://${domain}`;
  return { store: { name, domain, url }, onInstacart: raw.onInstacart === true, items: out, fallback: false };
}

/** Search the web (Claude web search or Gemini Google Search grounding) for one retailer that sells the items. */
export async function findOnline(
  items: ParsedItem[],
  opts: { allowedDomains?: string[]; region?: string; store?: string; service?: string; maxTotal?: number; maxPerItem?: number } = {},
): Promise<WebFind | null> {
  const provider = aiProvider();
  const g = provider === "gemini" ? ai() : undefined;
  if (provider === "none" || (provider === "gemini" && !g)) throw new SearchUnavailableError("Online search is not configured");
  const region = opts.region ?? "Vancouver, BC, Canada";
  const list = items.map((i) => `- ${i.requested} (qty ${i.qty})`).join("\n");
  const restrict = opts.allowedDomains?.length
    ? `The store MUST be one of these domains: ${opts.allowedDomains.join(", ")}.`
    : "Pick any real retailer.";
  const via = opts.service ? ` (the ${opts.service} listing for it is fine)` : " (or a delivery service listing that store, e.g. Uber Eats, DoorDash, SkipTheDishes)";
  const storeRule = opts.store
    ? `The user asked for ${opts.store}. The store MUST be ${opts.store}: its own website${via}. Never return look-alike products from another retailer; "storeName" must be ${opts.store}.`
    : restrict;
  const limit = opts.maxTotal ? `Keep the order total under $${opts.maxTotal} CAD.` : opts.maxPerItem ? `Keep each item under $${opts.maxPerItem} CAD.` : "";
  const prompt = `Find ONE real online retailer that sells all (or most) of these items, preferring stores in Canada / ${region}:
${list}
${opts.store && opts.allowedDomains?.length ? `${restrict}\n` : ""}${storeRule}${limit ? `\n${limit}` : ""}
Use web search to find real current prices. Reply with ONLY a JSON object, no prose, in this shape:
{"storeName": string, "domain": string, "storeUrl": string, "onInstacart": boolean,
 "items": [{"requested": string (exactly as listed above), "name": string, "brand": string|null, "size": string|null, "unitPrice": number (CAD, per unit), "url": string (product page)}]}
"onInstacart" is true only if this store is available on Instacart.`;
  try {
    if (provider === "claude") {
      const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] as any;
      const system =
        "You are a shopping lookup service. Your final message must be exactly one JSON object and nothing else. " +
        "Never answer in prose. If no single store has everything, pick the store that covers the most items (big general retailers like Walmart, Costco or Canadian Tire are fine) and include only the items you priced. " +
        "Only include prices you found; never invent a price.";
      // Web searches take 5-19 s: a longer per-request timeout and no retry (a retry would double the wait).
      const ask = (messages: any[]) =>
        claude()!.messages.create({ model: claudeModel(), max_tokens: 2048, system, messages, tools }, { timeout: 45_000, maxRetries: 0 });
      const finalText = (content: any[]) => {
        let last = -1;
        content.forEach((b, i) => { if (b.type === "web_search_tool_result") last = i; });
        return content.slice(last + 1).map((b) => (b.type === "text" ? b.text : "")).join("");
      };
      const first = await ask([{ role: "user", content: prompt }]);
      const found = validateFind(parseJson(finalText(first.content)), items, opts.allowedDomains, opts);
      if (found) return found;
      // One retry: hand back the searches it already did and ask for the JSON only.
      const retry = await ask([
        { role: "user", content: prompt },
        { role: "assistant", content: first.content },
        { role: "user", content: "Do not search again. Reply now with only the JSON object, using the best store and prices from your searches above." },
      ]);
      return validateFind(parseJson(finalText(retry.content)), items, opts.allowedDomains, opts);
    }
    const res = await g!.models.generateContent({
      model: model(),
      contents: prompt,
      config: { tools: [{ googleSearch: {} }], httpOptions: { timeout: 15_000, retryOptions: { attempts: 1 } } },
    });
    return validateFind(parseJson(res.text ?? ""), items, opts.allowedDomains, opts);
  } catch (e) {
    const err = e as { name?: string; status?: number; message?: string };
    console.warn(`Online product search failed: ${err?.name ?? "Error"}${err?.status ? ` ${err.status}` : ""}: ${String(err?.message ?? "").slice(0, 200)}`);
    throw new SearchUnavailableError();
  }
}
