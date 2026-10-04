import { OrderInputError, validQuantity, validateOrderLines } from "../services/orderValidation.js";
import { GoogleGenAI, Type } from "@google/genai";
import type { OrderLine, Product } from "@solpouch/shared";
import { aiProvider, claudeJson } from "./provider.js";

export interface ParsedItem {
  requested: string;
  qty: number;
}
export interface ParsedRequest {
  pouchHint?: string;
  /** The shop, restaurant or brand the user names (e.g. "McDonald's"). */
  store?: string;
  /** The delivery app the user names (e.g. "Uber Eats"). */
  service?: string;
  items: ParsedItem[];
}

// ---- Prompts: tune these ----
export const PARSE_PROMPT = `You turn a spoken or typed shopping request into a structured shopping list.
Return JSON: { "pouchHint": string|null, "store": string|null, "service": string|null, "items": [{ "requested": string, "qty": number }] }.
- "store" is the shop, restaurant or brand the user names (e.g. "McDonald's", "Tim Hortons", "Walmart"), else null.
- "service" is the delivery app the user names (e.g. "Uber Eats", "DoorDash"), else null.
- If the user names a store but no specific items ("a McDonald's order"), return an empty items array.
- Any product the user names is always an item, even when it implies the store: "Big Mac meal" gives items [{"requested": "Big Mac meal", "qty": 1}] with store "McDonald's".
- "requested" is the product in plain words, without quantity or filler (e.g. "8 foot 2x4 stud", "oat milk", "pad thai").
- "qty" is how many units the user wants (default 1). "ten boxes of screws" is qty 10.
- qty counts the units as sold: "2 dozen eggs" is qty 2 of "dozen eggs" (not 24 eggs), "a litre of milk" is qty 1.
- "pouchHint" is a budget/pouch name only (e.g. "groceries", "job materials"), else null. It is never the store or restaurant.
- Ignore price caps like "under $20"; do not invent items.`;

export const MATCH_PROMPT = `You match a shopping list to products in ONE merchant's catalog.
For each requested item return: { "requested": string, "requestedQty": number, "productId": string|null, "qty": number,
"matchScore": number 0..1, "substitution": boolean, "note": string|null }.
- Pick the best product by name, size, brand and spec (e.g. "8 foot" must match 8ft, "3 inch" must match 3in).
- NEVER pick a product with inStock=false. If the closest product is out of stock, choose the closest in-stock alternative,
  set substitution=true, lower matchScore, and write a note like "Oat milk was out, picked Silk instead".
- If nothing reasonable exists set productId=null, matchScore=0 and explain in note.
- matchScore: 1 = exactly what was asked, 0.5 = acceptable substitute, <0.3 = poor.
- Never invent product ids. Keep qty equal to requestedQty.`;

const model = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
let client: GoogleGenAI | undefined;
function ai(): GoogleGenAI | undefined {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return undefined;
  client ??= new GoogleGenAI({ apiKey: key });
  return client;
}

// ---- Public API ----

// JSON Schemas for Claude's forced tool output (same shapes as the Gemini response schemas below).
const PARSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    pouchHint: { type: ["string", "null"] },
    store: { type: ["string", "null"] },
    service: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { requested: { type: "string" }, qty: { type: "number" } },
        required: ["requested", "qty"],
      },
    },
  },
  required: ["items"],
};

const MATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requested: { type: "string" },
          requestedQty: { type: "number" },
          productId: { type: ["string", "null"] },
          qty: { type: "number" },
          matchScore: { type: "number" },
          substitution: { type: "boolean" },
          note: { type: ["string", "null"] },
        },
        required: ["requested", "requestedQty", "qty", "matchScore", "substitution"],
      },
    },
  },
  required: ["lines"],
};

type MatchRow = {
  requested: string;
  requestedQty: number;
  productId: string | null;
  qty: number;
  matchScore: number;
  substitution: boolean;
  note: string | null;
};

/** Model-supplied quantity as an integer in 1..1000. */
export function clampQty(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 1;
}

/** Model-supplied price: finite and non-negative, else undefined (treated as missing). */
export function cleanPrice(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const GEMINI_HTTP = { timeout: 15_000, retryOptions: { attempts: 1 } };

function finishParse(parsed: any): ParsedRequest | null {
  const items: ParsedItem[] = (parsed?.items ?? [])
    .filter((i: ParsedItem) => i?.requested)
    .map((i: ParsedItem) => ({ requested: String(i.requested).replace(/\s+/g, " ").trim(), qty: validQuantity(Number(i.qty ?? 1)) }));
  const store = typeof parsed?.store === "string" && parsed.store.trim() ? parsed.store.trim() : undefined;
  const service = typeof parsed?.service === "string" && parsed.service.trim() ? parsed.service.trim() : undefined;
  if (!items.length && !store) return null;
  return { pouchHint: parsed.pouchHint || undefined, ...(store ? { store } : {}), ...(service ? { service } : {}), items };
}

/**
 * Turns the model's rows into order lines, one per parsed item and in the same order.
 * requested and requestedQty always come from the parsed request, never from the match call,
 * so a model that changes a quantity produces qty !== requestedQty (and a note), which blocks auto-pay.
 * Returns null (use the offline fallback) when the rows do not line up with the parsed items.
 */
function finishMatch(rows: MatchRow[], items: ParsedItem[], catalog: Product[]): OrderLine[] | null {
  if (!Array.isArray(rows) || !rows.length || rows.length !== items.length) return null;
  const lines = rows.map((r, i) => {
    const item = items[i];
    const product = catalog.find((p) => p.id === r?.productId && p.inStock) ?? null;
    const qty = product ? validQuantity(Number(r.qty ?? item.qty)) : 0;
    const qtyChanged = !!product && (qty !== item.qty || Number(r.requestedQty ?? item.qty) !== item.qty);
    return {
      requested: item.requested,
      requestedQty: item.qty,
      product,
      qty,
      lineTotal: product ? product.unitPrice * qty : 0,
      matchScore: product ? Math.min(1, Math.max(0, r.matchScore)) : 0,
      substitution: product ? !!r.substitution : false,
      note: r?.note || (!product ? "No matching product" : qtyChanged ? `Quantity changed: you asked for ${item.qty}, the cart has ${qty}` : undefined),
    };
  });
  validateOrderLines(lines);
  return lines;
}

export async function parseRequest(text: string): Promise<ParsedRequest> {
  if (aiProvider() === "claude") {
    try {
      const done = finishParse(await claudeJson<any>({ system: PARSE_PROMPT, prompt: text, schema: PARSE_JSON_SCHEMA, name: "shopping_list", maxTokens: 1024 }));
      if (done) return done;
    } catch (e) {
      if (e instanceof OrderInputError) throw e;
      console.warn("[claude] parseRequest failed, using fallback:", (e as Error).message);
    }
    return fallbackParse(text);
  }
  const g = ai();
  if (g) {
    try {
      const res = await g.models.generateContent({
        model: model(),
        contents: text,
        config: {
          httpOptions: GEMINI_HTTP,
          systemInstruction: PARSE_PROMPT,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              pouchHint: { type: Type.STRING, nullable: true },
              store: { type: Type.STRING, nullable: true },
              service: { type: Type.STRING, nullable: true },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: { requested: { type: Type.STRING }, qty: { type: Type.NUMBER } },
                  required: ["requested", "qty"],
                },
              },
            },
            required: ["items"],
          },
        },
      });
      const done = finishParse(JSON.parse(res.text ?? "{}"));
      if (done) return done;
    } catch (e) {
      if (e instanceof OrderInputError) throw e;
      console.warn("[gemini] parseRequest failed, using fallback:", (e as Error).message);
    }
  }
  return fallbackParse(text);
}

export async function matchItems(items: ParsedItem[], catalog: Product[]): Promise<OrderLine[]> {
  if (aiProvider() === "claude" && catalog.length) {
    try {
      const slim = catalog.map((p) => ({ id: p.id, name: p.name, brand: p.brand, size: p.size, inStock: p.inStock }));
      const out = await claudeJson<{ lines?: MatchRow[] }>({
        system: MATCH_PROMPT + '\nReturn the rows in the "lines" array.', prompt: JSON.stringify({ items, catalog: slim }),
        schema: MATCH_JSON_SCHEMA, name: "matched_lines", maxTokens: 4096,
      });
      const done = finishMatch(out?.lines ?? [], items, catalog);
      if (done) return done;
    } catch (e) {
      if (e instanceof OrderInputError) throw e;
      console.warn("[claude] matchItems failed, using fallback:", (e as Error).message);
    }
    return fallbackMatch(items, catalog);
  }
  const g = ai();
  if (g && catalog.length) {
    try {
      const slim = catalog.map((p) => ({ id: p.id, name: p.name, brand: p.brand, size: p.size, inStock: p.inStock }));
      const res = await g.models.generateContent({
        model: model(),
        contents: JSON.stringify({ items, catalog: slim }),
        config: {
          httpOptions: GEMINI_HTTP,
          systemInstruction: MATCH_PROMPT,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                requested: { type: Type.STRING },
                requestedQty: { type: Type.NUMBER },
                productId: { type: Type.STRING, nullable: true },
                qty: { type: Type.NUMBER },
                matchScore: { type: Type.NUMBER },
                substitution: { type: Type.BOOLEAN },
                note: { type: Type.STRING, nullable: true },
              },
              required: ["requested", "requestedQty", "qty", "matchScore", "substitution"],
            },
          },
        },
      });
      const done = finishMatch(JSON.parse(res.text ?? "[]") as MatchRow[], items, catalog);
      if (done) return done;
    } catch (e) {
      if (e instanceof OrderInputError) throw e;
      console.warn("[gemini] matchItems failed, using fallback:", (e as Error).message);
    }
  }
  return fallbackMatch(items, catalog);
}

// ---- Deterministic offline fallback ----

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12,
};
const PREFIX = /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:get me|get|i need|i want|order|buy|grab|pick up)\s+/;
const UNITS = /^(?:boxes|box|bags|bag|cartons|carton|packs|pack|sheets|sheet|bottles|bottle|loaves|loaf|orders|order|of)\s+/;
const STOP = new Set(["of", "the", "a", "an", "some", "box", "boxes", "bag", "sheet", "sheets", "pack", "with", "for", "and", "in"]);

const SERVICES: Array<[RegExp, string]> = [
  [/uber\s?eats/i, "Uber Eats"], [/door\s?dash/i, "DoorDash"], [/skip\s?the\s?dishes/i, "SkipTheDishes"], [/grubhub/i, "Grubhub"],
];
const CAP = String.raw`[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*)*`;
const GENERIC_ITEM = /^(?:something|anything|food|stuff|a meal|meal|lunch|dinner)$/;

export function fallbackParse(text: string): ParsedRequest {
  let src = text;
  let service: string | undefined;
  for (const [re, name] of SERVICES) {
    const m = src.match(new RegExp(String.raw`(?:\s+(?:on|via|through|using|with)\b)?\s*${re.source}`, "i"));
    if (m) { service = name; src = src.replace(m[0], " "); break; }
  }
  let store: string | undefined;
  const sm = src.match(new RegExp(String.raw`\b(?:from|at)\s+(${CAP})`)) ?? src.match(new RegExp(String.raw`\b(?:[Aa]n?|[Tt]he)\s+(${CAP})\s+order\b`));
  if (sm) {
    store = sm[1].replace(/[.!?]+$/, "");
    src = src.replace(sm[0], " ");
  }
  let t = src.toLowerCase().trim();
  t = t.replace(/\b(?:under|below|up to|for less than|less than|max)\s+\$?\d+(?:\.\d+)?\b/g, " ");
  t = t.replace(PREFIX, "");
  const parts = t.split(/,|\band\b|\bplus\b/).map((s) => s.trim()).filter(Boolean);
  const items: ParsedItem[] = [];
  for (let part of parts) {
    part = part.replace(PREFIX, "");
    let qty = 1;
    const m = part.match(/^(\d+)\s+/);
    const w = part.match(/^([a-z]+)\s+/);
    const dz = part.match(/^(\d+|[a-z]+)\s+dozen\s+/);
    if (dz && (/^\d+$/.test(dz[1]) || (NUM_WORDS[dz[1]] !== undefined && dz[1] !== "dozen"))) {
      qty = /^\d+$/.test(dz[1]) ? parseInt(dz[1], 10) : NUM_WORDS[dz[1]];
      part = part.slice(dz[1].length + 1);
    } else if (m) {
      qty = parseInt(m[1], 10);
      part = part.slice(m[0].length);
    } else if (w && NUM_WORDS[w[1]] !== undefined) {
      qty = NUM_WORDS[w[1]];
      part = part.slice(w[0].length);
    }
    for (let i = 0; i < 2; i++) part = part.replace(UNITS, "");
    part = part.replace(/[.!?]+$/, "").trim();
    if (part && !(store && GENERIC_ITEM.test(part))) items.push({ requested: part, qty: validQuantity(qty) });
  }
  const hints: Array<[RegExp, string]> = [
    [/uber|takeout|delivery|dinner|lunch/, "uber eats"],
    [/grocer|milk|eggs|bread/, "groceries"],
    [/kim|job|material|lumber|stud|screw/, "kim job: materials"],
  ];
  const pouchHint = hints.find(([re]) => re.test(src.toLowerCase()))?.[1];
  return { pouchHint, ...(store ? { store } : {}), ...(service ? { service } : {}), items };
}

function tokens(s: string): string[] {
  const n = s
    .toLowerCase()
    .replace(/(\d+)\s*(?:-|\s)?\s*(?:foot|feet|ft)\b/g, "$1ft")
    .replace(/(\d+)\s*(?:-|\s)?\s*(?:inch|inches|in|")(?![a-z])/g, "$1in")
    .replace(/[^a-z0-9/ ]+/g, " ");
  return n
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !/\d/.test(w) ? w.slice(0, -1) : w.replace(/^(\d+x\d+)s$/, "$1")));
}

export function scoreProduct(requested: string, p: Product): number {
  const req = tokens(requested);
  if (!req.length) return 0;
  const hay = new Set(tokens(`${p.name} ${p.brand ?? ""} ${p.size ?? ""}`));
  const hit = req.filter((t) => hay.has(t)).length;
  return hit / req.length;
}

/** How well a catalog covers a list of items (used to pick the merchant). */
export function catalogFit(items: ParsedItem[], catalog: Product[]): number {
  let total = 0;
  for (const it of items) total += Math.max(0, ...catalog.map((p) => scoreProduct(it.requested, p)));
  return total;
}

export function fallbackMatch(items: ParsedItem[], catalog: Product[]): OrderLine[] {
  return items.map((it): OrderLine => {
    const ranked = catalog
      .map((p) => ({ p, s: scoreProduct(it.requested, p) }))
      .sort((a, b) => b.s - a.s);
    const best = ranked[0];
    const none = (note: string): OrderLine => ({
      requested: it.requested, requestedQty: it.qty, product: null, qty: 0, lineTotal: 0, matchScore: 0,
      substitution: false, note,
    });
    if (!best || best.s < 0.4) return none(`No product found for "${it.requested}"`);
    if (best.p.inStock) {
      return {
        requested: it.requested, requestedQty: it.qty, product: best.p, qty: it.qty,
        lineTotal: best.p.unitPrice * it.qty, matchScore: best.s, substitution: false,
      };
    }
    const alt = ranked.find((r) => r.p.inStock && r.s >= 0.3);
    if (!alt) return none(`${best.p.name} is out of stock and no substitute was found`);
    return {
      requested: it.requested, requestedQty: it.qty, product: alt.p, qty: it.qty,
      lineTotal: alt.p.unitPrice * it.qty, matchScore: Math.min(0.7, alt.s * 0.7), substitution: true,
      note: `${best.p.name} was out of stock, picked ${alt.p.name} instead`,
    };
  });
}
