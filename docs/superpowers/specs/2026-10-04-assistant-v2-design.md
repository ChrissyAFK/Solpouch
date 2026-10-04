# Assistant v2: verified, fast order finding

Date: 2026-10-04. Branch `feat/assistant-v2`. Approved in conversation by Tariq.

## Goal

The assistant takes any shopping request (fast food, restaurants, groceries, building
materials, general retail) by voice or text and returns a cart that is right: the real
store, the real product, the real current price. When it cannot be sure it says so or
asks. It never guesses.

Success criteria:

- A first-time single-store request ("best Popeyes meal under $15") returns in about
  10 s; a repeated one in about 2 s.
- Every price in a cart is either verified against a fetched page or labelled an estimate.
- A misheard or incomplete request produces a question, not a cart.
- An eval set of about 40 real requests reports store, item, price status and seconds
  per request, so accuracy is measured.

## What is wrong today

- One Haiku call with 3 web searches picks the store and prices every item
  (`ai/findOnline.ts`).
- No product page is ever fetched; prices, sizes and availability are unverified.
- The 35-product built-in catalogs win over real search at a 0.3 word-overlap score
  (`services/orders.ts`, `catalogFit`, `MATCH_THRESHOLD`).
- `fallbackParse` and `fallbackMatch` build carts by regex when the AI call fails.
- Neither voice nor chat can ask a clarifying question.
- The ElevenLabs recogniser has no keyword list and speculative turns are on.

## Pipeline

New folder `apps/backend/src/assistant/`, one file per stage. `createDraft` in
`services/orders.ts` calls `findCart` and keeps pouch choice, rule checks and draft
assembly.

### 1. `understand.ts`

`understand(text, ctx: { pouchNames: string[] }): Promise<Understood>`

One Haiku call, no tools, JSON output, 6 s timeout, one retry.

```ts
interface WantedItem { requested: string; qty: number; size?: string; brand?: string }
interface Understood {
  items: WantedItem[];
  store?: string;            // "Popeyes"
  service?: string;          // "Uber Eats"
  pouchHint?: string;
  category: "restaurant" | "grocery" | "building" | "retail" | "other";
  chooseItems: boolean;      // store + budget, no items: the search picks a meal
  clarify?: { question: string; reason: "missing_detail" | "misheard" | "not_shopping" };
}
```

- `clarify` is set when an essential detail is missing (size or quantity where the
  product cannot be bought without it) or when the text is implausible as a shopping
  request ("50 novels" after a voice call). At most one question per turn.
- Budget stays with the existing `parseRequestConstraints` (code, not AI).
- If the call fails after its retry, `understand` throws `SearchUnavailableError`.
  `fallbackParse` is deleted from the draft path.

### 2. `cache.ts`

Table `product_cache(store_domain, item_key, product jsonb, verified_at)`, key =
normalised store domain + normalised requested text + size. TTL 24 h. Only verified
items are written. In-memory map when the store is not Postgres.

### 3. `search.ts`

`searchItems(u: Understood, opts): Promise<Candidate[]>`

- Store named: one search task for the whole request at that store.
- No store: one task per item, run in parallel, then pick the store that covers the
  most items (ties: lowest total).
- Each task is one Claude call with the web search tool, `max_uses` 2, 12 s timeout,
  no retry. Model from `ANTHROPIC_SEARCH_MODEL`, default chosen from the eval.
- Output per item: `{ requested, name, brand?, size?, unitPrice, url, storeName, domain }`.
- Existing `validateFind` rules stay: plain hostname, store match, allowed domains,
  single finite price.

### 4. `verify.ts`

`verifyCandidate(c: Candidate): Promise<"verified" | "estimate">`. No AI call.

- Fetch `c.url` over https with a 3 s timeout, 1.5 MB cap, browser-like user agent.
- Safety: only public hostnames on the candidate's own domain; refuse IP literals,
  private and loopback ranges, and redirects that leave the domain.
- Verified when the page carries the price next to the product: schema.org
  `Product`/`Offer` JSON-LD with a matching name and price, or the price string within
  300 characters of at least half of the name's tokens in the page text.
- Anything else (blocked, timeout, no match) is `estimate`. The search price is kept,
  `product.estimated = true` (field already exists in `packages/shared`).
- All candidates are verified in parallel.

### 5. `findCart.ts`

`findCart(text, ctx): Promise<{ kind: "cart"; ... } | { kind: "clarify"; question }>`

Order: understand → cache → search → verify → write cache. Total budget 20 s; on
expiry it returns what is verified so far and lists the rest as not found.

- Missing items are listed as missing. No substitution from another store.
- Built-in catalogs are used only when the request names that merchant or the pouch
  allows only catalog merchants. `MATCH_THRESHOLD` for that path rises to 0.6.
- `fallbackMatch` no longer produces a draft when the AI is down.
- Auto-pay requires every line to be verified. Any estimate forces confirmation.

## Errors and questions

| Case | HTTP | code | Voice says |
|---|---|---|---|
| Needs a detail or was misheard | 200 | `NeedClarification` | the question |
| Nothing found | 422 | `NotFound` | "I couldn't find X at Y." |
| AI or search down | 503 | `SearchUnavailable` | "I can't search right now." |

`POST /orders` and the voice `create_order` tool return
`{ clarify: { question } }` instead of an order for the first row. The `/order` page and
the chat widget show the question; the answer is sent as a new request with the
original text prepended.

## Voice

- `voice/prompt.md`: pass the user's exact words to `create_order`; say a short echo
  ("Popeyes meal under fifteen dollars, checking") before calling it; ask the
  `clarify` question verbatim; say which prices are estimates.
- Agent settings, applied through the REST API only when Tariq says so:
  `asr.keywords` (store, restaurant, delivery-app and product names plus "Solpouch" and
  "pouch"), `turn.speculative_turn = false`, `turn.turn_eagerness = "patient"`.
- Web: confirm echo cancellation and noise suppression on the Talk button's mic.

## Testing

- Unit tests (vitest, mocked Claude and fetch) per stage: understand output and
  clarify cases, cache hit and expiry, store choice, verify (JSON-LD, text match,
  blocked page, redirect off-domain, private address), findCart budget expiry.
- Existing `order-finding`, `findOnline`, `claude`, `auto-confirm` tests updated to the
  new path.
- `apps/backend/eval/requests.json` (about 40 requests across the five categories) and
  `eval/run.ts`, run by hand against the live pipeline. Prints a table and totals. Not
  part of `pnpm test` (it costs money).

## Out of scope

Real checkout at retailers, per-store APIs, location-specific pricing, accounts or
sign-in changes, redesign of the cart UI beyond the verified/estimate label and the
question prompt.

## Limits

- A never-seen request cannot be faster than the web search itself (about 5 to 8 s).
- Delivery apps and some retailers block fetching, so some prices stay estimates.
- Cost per uncached order rises from about 1 to 3 cents to about 5 to 10 cents.
