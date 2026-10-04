# Assistant v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant returns a cart with the real store, product and price for any shopping request, flags what it could not verify, asks when it is unsure, and answers fast.

**Architecture:** `createDraft` keeps pouch choice and draft assembly. Three new modules sit in front of it: `understand` (structured request or a clarifying question), `findCart` (search, then verify each price against the fetched product page, with a result cache), and `verifyPrice` (page fetch and price check in plain code). Built-in catalogs stop competing with real search when an AI provider is configured.

**Tech Stack:** TypeScript, Hono, vitest, `@anthropic-ai/sdk` (Haiku 4.5 for understanding, web search tool for finding), Node 24 `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-04-assistant-v2-design.md`

## Global Constraints

- All work on branch `feat/assistant-v2` in the worktree `Solpouch-assistant`. Never edit, build or restart anything in the `Solpouch` checkout (it is production).
- Backend tests: `pnpm --filter ./apps/backend test`. Typecheck: `pnpm -r typecheck`. Both must pass at the end of every task.
- Tests never touch the network: Claude is mocked through `vi.mock("@anthropic-ai/sdk", ...)` and page fetches through injected `fetch`/`resolve`.
- A price is `verified` only when a fetched page on the store's own domain shows it. Everything else is an estimate (`product.estimated = true`).
- No regex-built or catalog look-alike cart when an AI provider is configured. With no provider (offline dev and tests) the old catalog path stays.
- Clarifying question: at most one per request.
- Prices are CAD. A page price in another currency never verifies.
- Commit after each task; end commit messages with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Changes to the spec made while planning

- A clarifying question is returned as `HttpError(400, question, "NeedClarification")`, the same shape the existing `NeedItems` case uses, instead of a 200 body. Voice and web already surface error messages; they only need to present this code as a question.
- No store named: still one search call for the whole list (a cart has one store), with a search budget that grows with the item count, instead of one call per item.
- The cache is in memory (the API is one long-running process). Fully verified results live 24 h, results with any estimate live 1 h.

## Review Focus

1. A product URL that redirects to another domain or resolves to a private address: must end as an estimate, never be fetched. (Task 1)
2. A page whose JSON-LD price is in USD: must not replace the CAD price. (Task 1)
3. The model asks a clarifying question for an everyday item ("milk"): the prompt must forbid it; the eval set checks it. (Tasks 2, 7)
4. Claude is down or times out: the user hears "can't search right now", and no regex cart is built. (Tasks 2, 4)
5. A cached result is served for a pouch that only allows other stores: the cache key includes the allowed domains. (Task 3)

---

### Task 1: `verifyPrice` — check a price against the product page

**Files:**
- Create: `apps/backend/src/ai/verifyPrice.ts`
- Test: `apps/backend/test/verifyPrice.test.ts`

**Interfaces:**
- Consumes: `safeUrlForDomain(raw: unknown, domain: string): string | undefined` and `parseSinglePrice(v: unknown): number` from `apps/backend/src/ai/findOnline.ts`.
- Produces:
  - `type PriceCheck = { status: "verified"; unitPrice: number } | { status: "estimate"; reason: string }`
  - `interface VerifyDeps { fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]> }`
  - `verifyPrice(c: { name: string; unitPrice: number; url?: string }, domain: string, deps?: VerifyDeps): Promise<PriceCheck>`
  - `isPrivateAddress(ip: string): boolean`, `jsonLdProducts(html: string)`, `textHasPrice(text: string, name: string, price: number): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/test/verifyPrice.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/backend exec vitest run test/verifyPrice.test.ts`
Expected: FAIL, cannot find module `../src/ai/verifyPrice.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/backend/src/ai/verifyPrice.ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter ./apps/backend exec vitest run test/verifyPrice.test.ts` then `pnpm --filter ./apps/backend typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/ai/verifyPrice.ts apps/backend/test/verifyPrice.test.ts
git commit -m "Verify searched prices against the product page"
```

---

### Task 2: `understand` — structured request or one clarifying question

**Files:**
- Create: `apps/backend/src/ai/understand.ts`
- Modify: `apps/backend/src/ai/provider.ts:21-41` (add `timeoutMs` to `claudeJson`)
- Modify: `apps/backend/src/ai/gemini.ts:119` (export `finishParse`)
- Test: `apps/backend/test/understand.test.ts`

**Interfaces:**
- Consumes: `claudeJson`, `aiProvider` (`ai/provider.ts`); `parseRequest`, `finishParse`, `PARSE_PROMPT`, `ParsedRequest` (`ai/gemini.ts`); `SearchUnavailableError` (`ai/storeMatch.ts`).
- Produces:
  - `type ClarifyReason = "missing_detail" | "misheard" | "not_shopping"`
  - `interface Understood extends ParsedRequest { clarify?: { question: string; reason: ClarifyReason } }`
  - `understand(text: string): Promise<Understood>` — throws `SearchUnavailableError` when Claude is configured but the call fails.
  - `UNDERSTAND_PROMPT: string`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/test/understand.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { understand, UNDERSTAND_PROMPT } from "../src/ai/understand.js";
import { SearchUnavailableError } from "../src/ai/storeMatch.js";

const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: m.create }; } }));
const reply = (input: unknown) => ({ content: [{ type: "tool_use", name: "shopping_list", input }] });

beforeEach(() => { vi.stubEnv("GEMINI_API_KEY", ""); vi.stubEnv("ANTHROPIC_API_KEY", "fake"); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); m.create.mockReset(); });

describe("understand", () => {
  it("returns items, store and service with no question", async () => {
    m.create.mockResolvedValue(reply({ store: "Popeyes", service: "Uber Eats", items: [{ requested: "3 piece tenders combo", qty: 1 }], clarify: null }));
    expect(await understand("3 piece tenders combo from Popeyes on Uber Eats")).toEqual({ store: "Popeyes", service: "Uber Eats", items: [{ requested: "3 piece tenders combo", qty: 1 }] });
    expect(m.create.mock.calls[0][1]).toMatchObject({ timeout: 8000 });
  });
  it("passes a clarifying question through", async () => {
    m.create.mockResolvedValue(reply({ items: [{ requested: "screws", qty: 1 }], clarify: { question: "What size and type of screws?", reason: "missing_detail" } }));
    expect((await understand("get me some screws")).clarify).toEqual({ question: "What size and type of screws?", reason: "missing_detail" });
  });
  it("asks what to order when there is nothing to buy", async () => {
    m.create.mockResolvedValue(reply({ items: [], clarify: null }));
    expect((await understand("hello there")).clarify).toEqual({ question: "What would you like me to order?", reason: "not_shopping" });
  });
  it("drops a malformed clarify and an over-long question", async () => {
    m.create.mockResolvedValue(reply({ items: [{ requested: "milk", qty: 1 }], clarify: { question: "", reason: "missing_detail" } }));
    expect((await understand("milk")).clarify).toBeUndefined();
    m.create.mockResolvedValue(reply({ items: [{ requested: "milk", qty: 1 }], clarify: { question: "x".repeat(400), reason: "nope" } }));
    const u = await understand("milk");
    expect(u.clarify?.question.length).toBeLessThanOrEqual(200);
    expect(u.clarify?.reason).toBe("missing_detail");
  });
  it("throws SearchUnavailableError when Claude fails, and never builds a regex cart", async () => {
    m.create.mockRejectedValue(new Error("overloaded"));
    await expect(understand("2 eggs and 1 bread")).rejects.toBeInstanceOf(SearchUnavailableError);
  });
  it("without a Claude key it uses the old parser (offline mode)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await understand("2 eggs and 1 bread")).toMatchObject({ items: [{ requested: "eggs", qty: 2 }, { requested: "bread", qty: 1 }] });
    expect(m.create).not.toHaveBeenCalled();
  });
  it("the prompt forbids questions about everyday items", () => {
    expect(UNDERSTAND_PROMPT).toMatch(/everyday/i);
    expect(UNDERSTAND_PROMPT).toMatch(/Did you say/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/backend exec vitest run test/understand.test.ts`
Expected: FAIL, cannot find module `../src/ai/understand.js`.

- [ ] **Step 3: Add `timeoutMs` to `claudeJson` and export `finishParse`**

In `apps/backend/src/ai/provider.ts`, add `timeoutMs?: number;` to the `claudeJson` options type and pass request options as the second argument:

```ts
  const res = await c.messages.create(
    {
      model: claudeModel(),
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
      tools: [{ name: opts.name, description: "Return the structured result.", input_schema: opts.schema as any }],
      tool_choice: { type: "tool", name: opts.name },
    },
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
  );
```

In `apps/backend/src/ai/gemini.ts:119` change `function finishParse(` to `export function finishParse(`.

- [ ] **Step 4: Write the implementation**

```ts
// apps/backend/src/ai/understand.ts
import { OrderInputError } from "../services/orderValidation.js";
import { finishParse, PARSE_PROMPT, parseRequest, type ParsedRequest } from "./gemini.js";
import { aiProvider, claudeJson } from "./provider.js";
import { SearchUnavailableError } from "./storeMatch.js";

export type ClarifyReason = "missing_detail" | "misheard" | "not_shopping";
export interface Understood extends ParsedRequest {
  /** Set when the assistant must ask the user one question before searching. */
  clarify?: { question: string; reason: ClarifyReason };
}

export const UNDERSTAND_PROMPT = `${PARSE_PROMPT}
Also return "clarify": null, or { "question": string, "reason": "missing_detail" | "misheard" | "not_shopping" }.
The text may come from speech recognition. Set "clarify" ONLY in these cases, otherwise it is null:
- "misheard": the text is not plausible as something a person would ask a shopping assistant to buy, or reads like a speech-recognition error (for example "50 novels" or "by me a pop ice"). Ask "Did you say ...?" with your best guess of what was meant.
- "missing_detail": a wrong guess would be useless, for example fasteners, lumber, parts or cables with no size or type, or clothing and shoes with no size. Ask for exactly the missing detail.
- "not_shopping": the text is not a request to buy anything. Ask what they would like to order.
NEVER ask about everyday items that have a sensible default (milk, eggs, bread, coffee, a burger, fries, a pizza, toilet paper): choose the common default and leave "clarify" null.
A store with a budget but no items ("a Popeyes meal under $15") is complete: leave "clarify" null.
The question is one short spoken sentence, under 20 words. When "clarify" is set, still fill "items" as best you can.`;

const UNDERSTAND_SCHEMA = {
  type: "object",
  properties: {
    pouchHint: { type: ["string", "null"] },
    store: { type: ["string", "null"] },
    service: { type: ["string", "null"] },
    items: {
      type: "array",
      items: { type: "object", properties: { requested: { type: "string" }, qty: { type: "number" } }, required: ["requested", "qty"] },
    },
    clarify: {
      type: ["object", "null"],
      properties: { question: { type: "string" }, reason: { type: "string", enum: ["missing_detail", "misheard", "not_shopping"] } },
      required: ["question", "reason"],
    },
  },
  required: ["items"],
};

const REASONS: ClarifyReason[] = ["missing_detail", "misheard", "not_shopping"];

/** Turn a request into a shopping list, or one question to ask first. */
export async function understand(text: string): Promise<Understood> {
  // Gemini and offline mode keep the old parser; they cannot ask questions.
  if (aiProvider() !== "claude") return parseRequest(text);
  let raw: any;
  try {
    raw = await claudeJson<any>({ system: UNDERSTAND_PROMPT, prompt: text, schema: UNDERSTAND_SCHEMA, name: "shopping_list", maxTokens: 1024, timeoutMs: 8000 });
  } catch (e) {
    console.warn("[claude] understand failed:", (e as Error).message);
    throw new SearchUnavailableError("The assistant is unavailable right now");
  }
  let parsed: ParsedRequest | null;
  try {
    parsed = finishParse(raw);
  } catch (e) {
    if (e instanceof OrderInputError) throw e;
    parsed = null;
  }
  const q = typeof raw?.clarify?.question === "string" ? raw.clarify.question.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const clarify = q ? { question: q, reason: REASONS.includes(raw.clarify.reason) ? (raw.clarify.reason as ClarifyReason) : "missing_detail" } : undefined;
  if (!parsed) return { items: [], clarify: clarify ?? { question: "What would you like me to order?", reason: "not_shopping" } };
  return clarify ? { ...parsed, clarify } : parsed;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter ./apps/backend exec vitest run test/understand.test.ts test/claude.test.ts test/order-finding.test.ts` then `pnpm --filter ./apps/backend typecheck`
Expected: all pass. If the first test's `toEqual` fails on a `pouchHint: undefined` key, that is fine for `toEqual`; do not change `finishParse`.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/ai/understand.ts apps/backend/src/ai/provider.ts apps/backend/src/ai/gemini.ts apps/backend/test/understand.test.ts
git commit -m "Understand step: structured request or one clarifying question"
```

---

### Task 3: `findCart` — search, verify, cache; faster search settings

**Files:**
- Create: `apps/backend/src/ai/findCart.ts`
- Modify: `apps/backend/src/ai/findOnline.ts:8-16` (`WebFindItem.verified`), `:125-190` (search model, search budget, timeouts, product-page URL rule)
- Test: `apps/backend/test/findCart.test.ts`; update `apps/backend/test/findOnline.test.ts` if it asserts `max_uses: 3` or the 45 s timeout

**Interfaces:**
- Consumes: `findOnline(items, opts)` and `WebFind`, `WebFindItem` (`ai/findOnline.ts`); `verifyPrice` and `PriceCheck` (Task 1); `ParsedItem` (`ai/gemini.ts`).
- Produces:
  - `WebFindItem` gains `verified?: boolean`
  - `type FindOpts = NonNullable<Parameters<typeof findOnline>[1]>`
  - `findCart(items: ParsedItem[], opts?: FindOpts, deps?: { find?: typeof findOnline; verify?: typeof verifyPrice; now?: () => number }): Promise<WebFind | null>`
  - `clearFindCache(): void`
  - Env: `ANTHROPIC_SEARCH_MODEL` (search model, default = `claudeModel()`), `VERIFY_PRICES=0` turns page checks off.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/test/findCart.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFindCache, findCart } from "../src/ai/findCart.js";
import type { WebFind } from "../src/ai/findOnline.js";

const found = (over: Partial<WebFind> = {}): WebFind => ({
  store: { name: "Store", domain: "store.ca", url: "https://store.ca" },
  onInstacart: false,
  fallback: false,
  items: [
    { requested: "deck screws", name: "Deck Screws 3in", unitPrice: 12.99, url: "https://store.ca/p/1" },
    { requested: "wood glue", name: "Wood Glue 500ml", unitPrice: 8.49, url: "https://store.ca/p/2" },
  ],
  ...over,
});
const items = [{ requested: "deck screws", qty: 1 }, { requested: "wood glue", qty: 2 }];

beforeEach(() => { clearFindCache(); vi.stubEnv("VERIFY_PRICES", "1"); });
afterEach(() => vi.unstubAllEnvs());

describe("findCart", () => {
  it("marks each item verified or not and takes the page price", async () => {
    const find = vi.fn(async () => found());
    const verify = vi.fn(async (c: { name: string }) => (c.name.startsWith("Deck") ? { status: "verified" as const, unitPrice: 13.49 } : { status: "estimate" as const, reason: "blocked" }));
    const r = await findCart(items, {}, { find, verify });
    expect(r!.items.map((i) => [i.verified, i.unitPrice])).toEqual([[true, 13.49], [false, 8.49]]);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0][1]).toBe("store.ca");
  });
  it("a verify that throws leaves the item an estimate", async () => {
    const r = await findCart(items, {}, { find: async () => found(), verify: async () => { throw new Error("boom"); } });
    expect(r!.items.every((i) => i.verified === false)).toBe(true);
  });
  it("serves a repeat from the cache and returns a copy", async () => {
    const find = vi.fn(async () => found());
    const verify = async () => ({ status: "verified" as const, unitPrice: 5 });
    const a = await findCart(items, { store: "Store" }, { find, verify });
    a!.items[0].unitPrice = 999;
    const b = await findCart([...items].reverse(), { store: "store" }, { find, verify });
    expect(find).toHaveBeenCalledTimes(1);
    expect(b!.items[0].unitPrice).toBe(5);
  });
  it("keys the cache on store, cap and allowed domains", async () => {
    const find = vi.fn(async () => found());
    const verify = async () => ({ status: "verified" as const, unitPrice: 5 });
    await findCart(items, {}, { find, verify });
    await findCart(items, { allowedDomains: ["other.ca"] }, { find, verify });
    await findCart(items, { maxTotal: 15 }, { find, verify });
    await findCart(items, { store: "Elsewhere" }, { find, verify });
    expect(find).toHaveBeenCalledTimes(4);
  });
  it("verified results live 24 h, results with an estimate 1 h", async () => {
    let t = 0;
    const now = () => t;
    const find = vi.fn(async () => found());
    await findCart(items, {}, { find, verify: async () => ({ status: "verified", unitPrice: 5 }), now });
    t = 23 * 3600_000; await findCart(items, {}, { find, now });
    expect(find).toHaveBeenCalledTimes(1);
    t = 25 * 3600_000; await findCart(items, {}, { find, verify: async () => ({ status: "estimate", reason: "x" }), now });
    expect(find).toHaveBeenCalledTimes(2);
    t += 2 * 3600_000; await findCart(items, {}, { find, verify: async () => ({ status: "estimate", reason: "x" }), now });
    expect(find).toHaveBeenCalledTimes(3);
  });
  it("does not cache nothing-found or the offline fallback, and passes errors through", async () => {
    const none = vi.fn(async () => null);
    await findCart(items, {}, { find: none }); await findCart(items, {}, { find: none });
    expect(none).toHaveBeenCalledTimes(2);
    const fb = vi.fn(async () => found({ fallback: true }));
    await findCart(items, {}, { find: fb }); await findCart(items, {}, { find: fb });
    expect(fb).toHaveBeenCalledTimes(2);
    await expect(findCart(items, { store: "X" }, { find: async () => { throw new Error("down"); } })).rejects.toThrow("down");
  });
  it("VERIFY_PRICES=0 skips page checks", async () => {
    vi.stubEnv("VERIFY_PRICES", "0");
    const verify = vi.fn();
    const r = await findCart(items, {}, { find: async () => found(), verify });
    expect(verify).not.toHaveBeenCalled();
    expect(r!.items.every((i) => i.verified === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/backend exec vitest run test/findCart.test.ts`
Expected: FAIL, cannot find module `../src/ai/findCart.js`.

- [ ] **Step 3: Write `findCart.ts`**

```ts
// apps/backend/src/ai/findCart.ts
import type { ParsedItem } from "./gemini.js";
import { findOnline, normalizeDomain, type WebFind } from "./findOnline.js";
import { verifyPrice } from "./verifyPrice.js";

export type FindOpts = NonNullable<Parameters<typeof findOnline>[1]>;
interface FindDeps { find?: typeof findOnline; verify?: typeof verifyPrice; now?: () => number }

const HOUR = 3600_000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { at: number; ttl: number; find: WebFind }>();
export function clearFindCache() { cache.clear(); }

const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
function cacheKey(items: ParsedItem[], o: FindOpts): string {
  return JSON.stringify([
    items.map((i) => norm(i.requested)).sort(),
    norm(o.store), norm(o.service), norm(o.region), o.maxTotal ?? null, o.maxPerItem ?? null, !!o.chooseItems,
    (o.allowedDomains ?? []).map(normalizeDomain).sort(),
  ]);
}
const copy = (f: WebFind): WebFind => ({ ...f, store: { ...f.store }, items: f.items.map((i) => ({ ...i })) });

/** Search for the items, then confirm each price against its product page. Repeats come from a short-lived cache. */
export async function findCart(items: ParsedItem[], opts: FindOpts = {}, deps: FindDeps = {}): Promise<WebFind | null> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(items, opts);
  const hit = cache.get(key);
  if (hit && now() - hit.at < hit.ttl) return copy(hit.find);
  cache.delete(key);

  const found = await (deps.find ?? findOnline)(items, opts);
  if (!found || found.fallback) return found;

  const verify = deps.verify ?? verifyPrice;
  const checks = process.env.VERIFY_PRICES === "0"
    ? found.items.map(() => ({ status: "estimate" as const, reason: "checks off" }))
    : await Promise.all(found.items.map((i) => verify(i, found.store.domain).catch(() => ({ status: "estimate" as const, reason: "check failed" }))));
  const out: WebFind = {
    ...found,
    items: found.items.map((i, n) => {
      const c = checks[n];
      return c.status === "verified" ? { ...i, unitPrice: c.unitPrice, verified: true } : { ...i, verified: false };
    }),
  };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now(), ttl: out.items.every((i) => i.verified) ? 24 * HOUR : HOUR, find: copy(out) });
  return out;
}
```

- [ ] **Step 4: Tune `findOnline.ts`**

1. In `WebFindItem` (line 8-16) add:

```ts
  /** True when the price was confirmed on the product's own page (set by findCart). */
  verified?: boolean;
```

2. In the Claude branch of `findOnline` (from line 152), replace the tools line and the `ask` helper:

```ts
      // A named store needs fewer searches; a list with no store gets more, up to 5.
      const maxUses = opts.store ? 2 : Math.min(5, 2 + items.length);
      const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }] as any;
      const searchModel = process.env.ANTHROPIC_SEARCH_MODEL || claudeModel();
      const started = Date.now();
      // The whole lookup gets 20 s: 15 s for the search, and the JSON-only retry only if time is left.
      const ask = (messages: any[], timeout: number) =>
        claude()!.messages.create({ model: searchModel, max_tokens: 2048, system, messages, tools }, { timeout, maxRetries: 0 });
```

Call the first request as `ask([...], 15_000)`. Before the existing retry, add:

```ts
      const left = 20_000 - (Date.now() - started);
      if (left < 4_000) return null;
```

and call the retry as `ask([...], left)`. Remove the old comment about 45 s.

3. In the prompt's JSON shape description, change the `url` field text from `string (product page)` to:

```
string (the product's or menu item's own page on the store's site, never the homepage; omit it if you did not open such a page)
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter ./apps/backend exec vitest run test/findCart.test.ts test/findOnline.test.ts test/order-finding.test.ts test/claude.test.ts` then `pnpm --filter ./apps/backend typecheck`
Expected: pass. Where an existing test asserts `max_uses: 3` or `timeout: 45_000`, update the expected value to the new behaviour (store named: 2; one item, no store: 3; timeout 15_000).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/ai/findCart.ts apps/backend/src/ai/findOnline.ts apps/backend/test/findCart.test.ts apps/backend/test/findOnline.test.ts
git commit -m "findCart: verified prices, result cache, faster search settings"
```

---

### Task 4: Wire `createDraft` (orchestrator does this one)

**Files:**
- Modify: `apps/backend/src/services/orders.ts:7-9, 72, 127-300`
- Modify: `apps/backend/vitest.config.ts` (or the `test` block of the backend's vite config): `env: { VERIFY_PRICES: "0" }`
- Test: `apps/backend/test/assistant-draft.test.ts`; update `apps/backend/test/order-finding.test.ts`

**Interfaces:**
- Consumes: `understand` (Task 2), `findCart` (Task 3).
- Produces: `createDraft` throws `HttpError(400, question, "NeedClarification")`; `HttpError(503, …, "SearchUnavailable")`; web lines carry `product.estimated = !verified`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backend/test/assistant-draft.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { getMerchant } from "../src/merchants/index.js";
import { MockVaultClient } from "../src/vault/mock.js";
import { createDraft, HttpError } from "../src/services/orders.js";
import { SearchUnavailableError } from "../src/ai/storeMatch.js";
import { ownedSeed, TEST_USER } from "./helpers.js";

const m = vi.hoisted(() => ({ understand: vi.fn(), findCart: vi.fn() }));
vi.mock("../src/ai/understand.js", () => ({ understand: (t: string) => m.understand(t) }));
vi.mock("../src/ai/findCart.js", () => ({ findCart: (...a: any[]) => m.findCart(...a), clearFindCache: () => {} }));

let store: MemoryStore;
let vault: MockVaultClient;
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "fake");
  store = new MemoryStore(ownedSeed());
  vault = new MockVaultClient(store, (id) => getMerchant(id)?.payTo);
});
afterEach(() => { vi.unstubAllEnvs(); m.understand.mockReset(); m.findCart.mockReset(); });
const draft = (req: string, pouch?: string) => createDraft({ store, vault }, TEST_USER, req, pouch);
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("expected rejection"); }, (e) => e);
const find = (items: any[]) => ({ store: { name: "Popeyes", domain: "popeyes.ca", url: "https://popeyes.ca" }, onInstacart: false, fallback: false, items });

describe("createDraft with the assistant", () => {
  it("returns the clarifying question and does not search", async () => {
    m.understand.mockResolvedValue({ items: [{ requested: "screws", qty: 1 }], clarify: { question: "What size and type of screws?", reason: "missing_detail" } });
    const e = await fail(draft("screws"));
    expect(e).toBeInstanceOf(HttpError);
    expect([e.status, e.code, e.message]).toEqual([400, "NeedClarification", "What size and type of screws?"]);
    expect(m.findCart).not.toHaveBeenCalled();
  });
  it("a store with no items and no budget asks what they want", async () => {
    m.understand.mockResolvedValue({ store: "Popeyes", items: [] });
    const e = await fail(draft("a Popeyes order"));
    expect([e.code, e.message]).toEqual(["NeedClarification", "What would you like from Popeyes?"]);
  });
  it("verified lines are not estimates; unverified lines are", async () => {
    m.understand.mockResolvedValue({ store: "Popeyes", items: [{ requested: "tenders combo", qty: 1 }, { requested: "biscuit", qty: 2 }] });
    m.findCart.mockResolvedValue(find([
      { requested: "tenders combo", name: "3pc Tenders Combo", unitPrice: 11.99, url: "https://popeyes.ca/menu/tenders", verified: true },
      { requested: "biscuit", name: "Biscuit", unitPrice: 1.99, verified: false },
    ]));
    const o = await draft("tenders combo and 2 biscuits from Popeyes");
    expect(o.lines.map((l) => [l.product?.estimated, l.note, l.matchScore])).toEqual([
      [false, undefined, 0.95],
      [true, "Estimated price from popeyes.ca. Check it before paying.", 0.8],
    ]);
  });
  it("with a provider configured, everyday items go to search, not the built-in catalog", async () => {
    m.understand.mockResolvedValue({ items: [{ requested: "eggs", qty: 2 }, { requested: "bread", qty: 1 }] });
    m.findCart.mockResolvedValue(null);
    const e = await fail(draft("2 eggs and 1 bread"));
    expect(m.findCart).toHaveBeenCalled();
    expect(e.code).toBe("NotFound");
  });
  it("a named built-in merchant still uses its catalog", async () => {
    const name = getMerchant("mountain-market")!.name;
    m.understand.mockResolvedValue({ store: name, items: [{ requested: "eggs", qty: 1 }] });
    const o = await draft(`eggs from ${name}`);
    expect(o.merchantId).toBe("mountain-market");
    expect(m.findCart).not.toHaveBeenCalled();
  });
  it("assistant or search down is 503 SearchUnavailable", async () => {
    m.understand.mockRejectedValue(new SearchUnavailableError("down"));
    let e = await fail(draft("milk"));
    expect([e.status, e.code]).toEqual([503, "SearchUnavailable"]);
    m.understand.mockResolvedValue({ items: [{ requested: "milk", qty: 1 }] });
    m.findCart.mockRejectedValue(new SearchUnavailableError("down"));
    e = await fail(draft("milk"));
    expect([e.status, e.code]).toEqual([503, "SearchUnavailable"]);
  });
});
```

(If `mountain-market`'s catalog has no product matching "eggs" at 0.6 or better, use a product name from `apps/backend/src/merchants/catalogs/mountain-market.json` in that test.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/backend exec vitest run test/assistant-draft.test.ts`
Expected: FAIL (no clarify error, catalog used for eggs, 422 instead of 503).

- [ ] **Step 3: Edit `createDraft`**

Imports (lines 7-9):

```ts
import { findCart } from "../ai/findCart.js";
import { SearchUnavailableError, storeMatches } from "../ai/storeMatch.js";
import { catalogFit, fallbackMatch, matchItems, type ParsedItem } from "../ai/gemini.js";
import { understand, type Understood } from "../ai/understand.js";
import { aiProvider } from "../ai/provider.js";
```

Line 72: `export const MATCH_THRESHOLD = 0.6;` when a provider is configured. Keep 0.3 offline:

```ts
/** Lowest matchScore a catalog line may have to count as covering the request (stricter once real search exists). */
export const MATCH_THRESHOLD = 0.3;
export const MATCH_THRESHOLD_ONLINE = 0.6;
```

Top of `createDraft` (replaces lines 129-137):

```ts
  const online = aiProvider() !== "none";
  const unavailable = () => new HttpError(503, "I can't search right now. Try again in a minute.", "SearchUnavailable");
  let parsed: Understood;
  try {
    parsed = savedItems ? { items: savedItems } : await understand(request);
  } catch (e) {
    if (e instanceof SearchUnavailableError) throw unavailable();
    throw e;
  }
  if (parsed.clarify) throw new HttpError(400, parsed.clarify.question, "NeedClarification");
  const { maxPrice, perItem } = parseRequestConstraints(request);
  const cap = maxPrice !== undefined ? maxPrice / 1_000_000 : undefined;
  // A store plus a price cap with no items: the search picks a typical order that fits the cap.
  const chooseItems = !parsed.items.length && !!parsed.store && cap !== undefined;
  if (!parsed.items.length && !chooseItems) {
    throw new HttpError(400, parsed.store ? `What would you like from ${parsed.store}?` : "What would you like me to order?", "NeedClarification");
  }
```

Catalog gate (after `candidateIds` is filtered by `parsed.store`, about line 171):

```ts
  // With real search available, a built-in catalog is used only when the user names that merchant,
  // the pouch allows nothing else, or the items come from a saved list. No look-alikes for everyday requests.
  const catalogOnlyPouch = !!pouch && !isAnyStore(pouch) && !webAllowed(pouch);
  if (online && !parsed.store && !catalogOnlyPouch && !savedItems) candidateIds = [];
```

Coverage line (about 186): `covered = catalogLines.every((l) => l.product && l.matchScore >= (online ? MATCH_THRESHOLD_ONLINE : MATCH_THRESHOLD));`

Web path: replace `findOnline(` with `findCart(` (same arguments), type `found` as `Awaited<ReturnType<typeof findCart>>`, and both `SearchUnavailable` throws (lines 218, 283) with `throw unavailable();`.

Line builder for a found item (replaces lines 240-261):

```ts
      const slug = w.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const unitPrice = toMicros(w.unitPrice);
      const verified = w.verified === true;
      return {
        requested: it.requested,
        requestedQty: it.qty,
        product: { id: `${WEB_PREFIX}${store.domain}:${slug}`, merchantId: merchant.id, name: w.name, brand: w.brand, size: w.size, unitPrice, inStock: true, url: w.url, estimated: !verified },
        qty: it.qty,
        lineTotal: unitPrice * it.qty,
        matchScore: verified ? 0.95 : 0.8,
        substitution: false,
        ...(verified ? {} : { note: `Estimated price from ${store.domain}. Check it before paying.` }),
      };
```

Step 3 of the function ("Both failed: partial catalog draft"): wrap in `if (!online || catalogOnlyPouch || savedItems) { … }` so a partial look-alike catalog draft is only produced offline, for catalog-only pouches or saved lists.

- [ ] **Step 4: Turn page checks off in tests**

In the backend vitest config add `env: { VERIFY_PRICES: "0" }` inside `test`. (`findCart.test.ts` stubs it back to `"1"`.)

- [ ] **Step 5: Update `order-finding.test.ts`**

- The `vi.mock("../src/ai/findOnline.js")` wrapper stays (findCart calls through it).
- `NeedItems` expectations become `NeedClarification`.
- `SearchUnavailable` expectations: status 503.
- Clear the cache between tests: `import { clearFindCache } from "../src/ai/findCart.js"` and call it in `beforeEach`.

- [ ] **Step 6: Run everything**

Run: `pnpm --filter ./apps/backend test` then `pnpm -r typecheck`
Expected: all pass. Any other test that fails because it expected the old `Estimated price from X` note or a 422 gets the new value; any failure that shows a real behaviour change outside this plan is reported, not patched over.

- [ ] **Step 7: Commit**

```bash
git add apps/backend
git commit -m "createDraft: understand, clarify, verified search, no catalog look-alikes"
```

---

### Task 5: Voice — readback, prompt, agent settings script

**Files:**
- Modify: `apps/backend/src/routes/voice.ts:22-45` (readbacks), `:127-130` (clarify)
- Modify: `voice/prompt.md`
- Create: `voice/apply-settings.mjs`, `voice/keywords.txt`
- Test: `apps/backend/test/voice-readback.test.ts`

**Interfaces:**
- Consumes: `HttpError.code === "NeedClarification"` (Task 4); `OrderLine.product.estimated`.
- Produces: `create_order` returns `{ say: question, needsConfirmation: false, needsAnswer: true, code: "NeedClarification" }` for a question; readback says "about $X, estimated" for estimated lines.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backend/test/voice-readback.test.ts
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ./apps/backend exec vitest run test/voice-readback.test.ts`
Expected: FAIL, "about $1.99, estimated" not found.

- [ ] **Step 3: Edit `voice.ts`**

In `readback` (line 32-36) and `itemsReadback` (line 24), use one helper:

```ts
const price = (l: Order["lines"][number]) => (l.product?.estimated ? `about ${usd(l.lineTotal)}, estimated` : usd(l.lineTotal));
```

and replace `${usd(l.lineTotal)}` with `${price(l)}` in both line formatters.

In the `create_order` catch (line 128):

```ts
          if (e instanceof HttpError) return c.json({ say: e.message, needsConfirmation: false, ...(e.code === "NeedClarification" ? { needsAnswer: true } : {}), ...(e.code ? { code: e.code } : {}) });
```

- [ ] **Step 4: Edit `voice/prompt.md`**

Add these rules to the ordering section (keep the rest):

```
- Before calling create_order, say a short echo of what you heard, for example "Popeyes meal under fifteen dollars, checking." Then call the tool.
- Pass the user's request to create_order in their exact words. Do not rephrase, translate, shorten or add to it.
- If the result has needsAnswer true, ask the `say` question exactly, wait for the answer, then call create_order again with the original request and the answer joined in one sentence.
- If the user corrects what you echoed, use their correction as the request.
- Read `say` exactly. When it says a price is estimated, say so; never present an estimate as a confirmed price.
```

- [ ] **Step 5: Create `voice/keywords.txt`** — one term per line, about 150 terms: `Solpouch`, `pouch`, `pouches`, delivery apps (`Uber Eats`, `DoorDash`, `SkipTheDishes`, `Instacart`), the 60 largest Canadian restaurant chains (`McDonald's`, `Tim Hortons`, `Popeyes`, `A&W`, `Wendy's`, `Subway`, `KFC`, `Burger King`, `Starbucks`, `Domino's`, `Pizza Hut`, `Chipotle`, `Five Guys`, `Dairy Queen`, `Harvey's`, `Mary Brown's`, `Boston Pizza`, `Nando's`, `Taco Bell`, `Triple O's`, `White Spot`, `Freshii`, `Booster Juice`, …), grocery and retail (`Walmart`, `Costco`, `Superstore`, `Save-On-Foods`, `Safeway`, `No Frills`, `T&T`, `Whole Foods`, `Shoppers Drug Mart`, `London Drugs`, `Canadian Tire`, `Best Buy`, `Amazon`, `IKEA`, `Dollarama`), building (`Home Depot`, `Rona`, `Lowe's`, `Home Hardware`, `Windsor Plywood`, `two by four`, `drywall`, `plywood`, `deck screws`, `rebar`), and common menu words (`Big Mac`, `McDouble`, `McNuggets`, `Whopper`, `Timbits`, `double double`, `tenders`, `combo`, `poutine`).

- [ ] **Step 6: Create `voice/apply-settings.mjs`**

```js
// Applies voice/prompt.md, voice/keywords.txt and turn settings to the live ElevenLabs agent.
// Run only when the owner says so: node voice/apply-settings.mjs [--dry-run]
import { readFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") });
const { ELEVENLABS_API_KEY: key, ELEVENLABS_AGENT_ID: id } = process.env;
if (!key || !id) throw new Error("ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID must be set in .env");
const here = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
const keywords = here("./keywords.txt").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const body = {
  conversation_config: {
    asr: { keywords },
    turn: { speculative_turn: false, turn_eagerness: "patient" },
    agent: { prompt: { prompt: here("./prompt.md") } },
  },
};
const url = `https://api.elevenlabs.io/v1/convai/agents/${id}`;
if (process.argv.includes("--dry-run")) {
  console.log(`would PATCH ${url}: ${keywords.length} keywords, speculative_turn=false, turn_eagerness=patient, prompt ${body.conversation_config.agent.prompt.prompt.length} chars`);
} else {
  const res = await fetch(url, { method: "PATCH", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 500)}`);
  const c = JSON.parse(text).conversation_config;
  console.log(`applied: ${c.asr.keywords.length} keywords, speculative_turn=${c.turn.speculative_turn}, turn_eagerness=${c.turn.turn_eagerness}`);
}
```

- [ ] **Step 7: Run and commit**

Run: `pnpm --filter ./apps/backend test`, `pnpm -r typecheck`, `node voice/apply-settings.mjs --dry-run` (run from a checkout that has `.env`; in this worktree it will stop with the "must be set" error, which is expected).
Do NOT run the script without `--dry-run`.

```bash
git add apps/backend/src/routes/voice.ts apps/backend/test/voice-readback.test.ts voice/
git commit -m "Voice: estimate wording, clarifying questions, echo rule, agent settings script"
```

---

### Task 6: Web — show the question and the verified/estimate state

**Files:**
- Modify: `apps/web/src/app/order/page.tsx:247-277` (question state), `:612-665` (line state)
- Modify: `apps/web/src/lib/api.ts` (only if the thrown error does not already expose the backend `code`)
- Read first: `apps/web/AGENTS.md` (this Next.js version differs from older ones)

**Interfaces:**
- Consumes: `POST /orders` error body with `code: "NeedClarification"` and the question as the message; `line.product.estimated`.

- [ ] **Step 1: Find how API errors carry `code`.** Open `apps/web/src/lib/api.ts`, find the error class thrown for non-2xx responses and `errMsg`. If the class has no `code` field, add `code?: string` filled from the response JSON's `code`.

- [ ] **Step 2: Question state on `/order`.** In the page component add `const [question, setQuestion] = useState<string | null>(null);`. In `createDraft`'s `catch`:

```tsx
    } catch (e) {
      if (!current()) return;
      if ((e as { code?: string })?.code === "NeedClarification") {
        setQuestion(errMsg(e));
        setRequest(text.replace(/[.\s]+$/, "") + ". ");
        requestInput.current?.focus();
      } else setError(errMsg(e));
    }
```

Clear it with `setQuestion(null)` next to the existing `setError(null)`. `requestInput` is a ref on the request textarea (add one if the textarea has none). Render the question above the form's submit row, using the page's existing amber "check this" style (`s.checkBox`):

```tsx
{question && (
  <div className={s.checkBox} role="status">
    <strong>One question · </strong>
    {question} Add the answer to your request and send it again.
  </div>
)}
```

- [ ] **Step 3: Line state.** At line 612, a web line is exact only when verified:

```tsx
                    const exact =
                      !!line.product &&
                      !line.substitution &&
                      !line.product.estimated &&
                      line.matchScore >= 0.9;
```

and the label at line 651 reads `{line.product?.url ? "Price confirmed on the store's page" : "Exact"}`.

- [ ] **Step 4: Check and commit**

Run: `pnpm --filter ./apps/web typecheck` and `pnpm --filter ./apps/web build`
Expected: both pass.

```bash
git add apps/web
git commit -m "Order page: clarifying question and confirmed/estimated price states"
```

---

### Task 7: Eval set and runner; choose the search model (orchestrator)

**Files:**
- Create: `apps/backend/eval/requests.json`, `apps/backend/eval/run.ts`

**Interfaces:**
- Consumes: `understand`, `findCart`, `parseRequestConstraints`.

- [ ] **Step 1: `requests.json`** — 40 entries `{ "text": string, "category": "fast_food" | "restaurant" | "grocery" | "building" | "retail" | "unclear", "expect": { "store"?: string, "clarify"?: boolean, "maxTotal"?: number } }`, 8 fast food, 6 restaurant, 8 grocery, 8 building, 6 retail, 4 unclear (for example "screws", "50 novels", "hello", "shoes from Nike"). Everyday items ("milk", "a dozen eggs") carry `"clarify": false`.

- [ ] **Step 2: `run.ts`**

```ts
// Run by hand; it calls the real APIs and costs a few cents per request:
//   npx tsx eval/run.ts [--only fast_food] [--limit 10]
import { config } from "dotenv";
import { readFileSync } from "node:fs";
config({ path: process.env.EVAL_ENV ?? "../../.env" });
const { understand } = await import("../src/ai/understand.js");
const { findCart } = await import("../src/ai/findCart.js");
const { parseRequestConstraints } = await import("../src/services/request-constraints.js");
const { storeMatches } = await import("../src/ai/storeMatch.js");

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
let cases: any[] = JSON.parse(readFileSync(new URL("./requests.json", import.meta.url), "utf8"));
if (arg("--only")) cases = cases.filter((c) => c.category === arg("--only"));
if (arg("--limit")) cases = cases.slice(0, Number(arg("--limit")));

const rows: any[] = [];
for (const c of cases) {
  const t0 = Date.now();
  const row: any = { text: c.text.slice(0, 44), cat: c.category, ok: false };
  try {
    const u = await understand(c.text);
    if (u.clarify) {
      row.result = `ASK: ${u.clarify.question}`.slice(0, 60);
      row.ok = c.expect?.clarify === true;
    } else {
      const { maxPrice, perItem } = parseRequestConstraints(c.text);
      const cap = maxPrice !== undefined ? maxPrice / 1_000_000 : undefined;
      const choose = !u.items.length && !!u.store && cap !== undefined;
      const f = await findCart(u.items, { store: u.store, service: u.service, ...(choose ? { chooseItems: true } : {}), ...(cap !== undefined ? (perItem ? { maxPerItem: cap } : { maxTotal: cap }) : {}) });
      if (!f) row.result = "NOT FOUND";
      else {
        const total = f.items.reduce((s, i) => s + i.unitPrice * (u.items.find((x) => x.requested === i.requested)?.qty ?? 1), 0);
        row.result = `${f.store.name} (${f.store.domain})`.slice(0, 40);
        row.items = `${f.items.length}/${choose ? f.items.length : u.items.length}`;
        row.verified = `${f.items.filter((i) => i.verified).length}/${f.items.length}`;
        row.total = total.toFixed(2);
        row.ok = c.expect?.clarify !== true && (!c.expect?.store || storeMatches(c.expect.store, f.store.name, f.store.domain)) &&
          (c.expect?.maxTotal === undefined || total <= c.expect.maxTotal) && f.items.length >= (choose ? 1 : u.items.length);
      }
    }
  } catch (e: any) {
    row.result = `ERROR ${e?.name}: ${e?.message}`.slice(0, 60);
  }
  row.s = ((Date.now() - t0) / 1000).toFixed(1);
  rows.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"} ${row.s}s  ${row.text}  ->  ${row.result}  ${row.verified ? `verified ${row.verified}` : ""}`);
}
const secs = rows.map((r) => Number(r.s)).sort((a, b) => a - b);
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed · median ${secs[Math.floor(secs.length / 2)]}s · slowest ${secs[secs.length - 1]}s`);
```

- [ ] **Step 3: Run it twice**, once with `ANTHROPIC_SEARCH_MODEL` unset (Haiku 4.5) and once with `ANTHROPIC_SEARCH_MODEL=claude-sonnet-5-5`, with `EVAL_ENV` pointing at the production `.env`. Record pass count, median and slowest seconds for both in `STATUS.md`. Keep the model with the higher pass count; if they are within 2 passes, keep the faster one.

- [ ] **Step 4: Fix what the eval shows.** Prompt wording in `UNDERSTAND_PROMPT` and the `findOnline` prompt may be tuned here; each change is re-run against the full set. Behaviour changes outside the prompts go back through a task.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/eval STATUS.md
git commit -m "Assistant eval set, runner and measured results"
```

---

## After the tasks

Whole-branch review by the `reviewer` agent, then stop. Merging into `scaffold`, deploying, and running `voice/apply-settings.mjs` against the live agent each wait for Tariq's explicit go.
