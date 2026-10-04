# Solpouch bug hunt

**Deadline: 2026-10-04 02:09 PDT** (started 01:09 PDT)

Summary (hunt ended 02:10 PDT, 26 runs, about 30 areas of backend, Anchor program, web app and demo scripts):
**19 valid bugs: 1 Critical, 2 High, 3 Medium, 13 Low.** #14 was retracted (false positive, kept for numbering).
- **Fix first: #20 Critical.** Production web build points at `http://localhost:8787`, so sign-in and every API call fail for real users (reported from mobile, confirmed from the live CSP).
- **#2 High:** free top-ups of up to $10k come from the owner's token account and can be withdrawn.
- **#6 High:** Stripe-minted funds never reach a pouch.
- **Medium:** #1 frozen pouches can still be picked for catalog orders; #4 voice errors come back without a spoken `say`; #11 the demo script's over-$30 regex misfires.
- Low: #3, #5, #7–#10, #12, #13, #15–#19 (validation gaps, truncated genesis hashes, cart-editor qty 0, parser edge cases, CAD shown as USD).
- Areas checked and sound: Anchor program, recovery/indexer, Postgres locking, auth session races, rate limiting, API error map, sessions UI.

## Fix status (2026-10-04)

All 19 valid bugs are fixed on `main` (commits 93ed843, 82abfbb, 10ddfb0, bef9fe8, d91adc4, c8020e8).
- #20: `apps/web/.env.production` points the build at `https://api.solpouch.tech`. The live site needs a restart on a new build (`.next-prod-b`) before phones can sign in.
- #6: Card money stays in the user's wallet, and the pouch page's "Move from wallet" section moves it into a pouch (`/allocations`). Not yet tried against real devnet or Phantom.
- #2: Top-ups have a rolling 24h per-account cap (`TOPUP_DAILY_LIMIT_USDC`, default 500).
- #12: The demo still falls back to an eligible pouch when the chosen one can't pay Uber Eats, on purpose for the stage demo.
- Re-test review findings fixed in d91adc4. Open note: two top-ups sent at the same moment could both pass the daily cap; found by reading the code and not reproduced.

## Areas covered

- [x] Run 1 — order flow: `services/orders.ts`, `services/orderValidation.ts`, `routes/orders.ts`. Baseline: backend 391 tests pass, `pnpm -r typecheck` clean.

- [x] Run 2 — top-ups and withdrawals: `services/topups.ts`, `routes/topups.ts`, `services/withdrawals.ts`, `routes/withdrawals.ts`, `security/access.ts`. Ownership scoping (`ownedStore`) checked: no cross-account access found.
- [x] Run 3 — voice webhook: `routes/voice.ts` (ElevenLabs server tools), secret check, `consumeBudget`/`clientIp`.
- [x] Run 4 — auth: `auth/session.ts`, `auth/google.ts`, `routes/auth.ts`, `security/wallet.ts`. **No bugs confirmed.** Checked: voice tokens die with their parent session on logout; JWT audiences are separated; wallet challenges are single-use and bound to session and origin; the double `/wallet` + `/wallet/*` lock middleware doesn't deadlock, because both stores' locks are re-entrant.
- [x] Run 5 — Stripe funding: `routes/stripe.ts`, `stripe/service.ts`, `stripe/mint.ts`, plus `vault/ownerTransactions.ts`. The quote math, session validation, idempotency and the mint journal all check out.
- [x] Run 6 — Transak funding: `routes/funding.ts`, `funding/transak.ts`, `funding/service.ts`, `funding/verification.ts`. The event state machine (status ranks, amount, wallet and receipt matching) and the webhook JWT check hold up. As documented, it is sandbox-only and never credits a pouch.
- [x] Run 7 — Anchor program `programs/solpouch_vault` (all 8 instructions plus `logic.rs`). **No bugs confirmed.** `cargo test --lib`: 17/17 pass. Checked: every owner instruction pins `has_one = owner` plus the PDA seeds; `pay` checks frozen, the allowlist (by token owner, then pinned to the canonical ATA), the per-order limit, the rolling 24h window with `checked_add`, and the balance; the receipt PDA blocks replaying an `order_id`; `set_rules` re-validates the merged rules. The program id matches across `lib.rs`, `Anchor.toml`, `.env` and both IDLs.
- [x] Run 8 — shopping lists and cart editing: `services/shopping.ts`, `routes/shoppingLists.ts`, `apps/web/src/app/order/CartEditor.tsx`. Ownership and version checks on lists hold up.
- [x] Run 9 — demo mode: `services/demoCheckout.ts`, `services/demoScript.ts`. The demo-checkout CAD→USD conversion (BigInt, rounded) and the re-validation of the quote at payment both hold up.
- [x] Run 10 — AI: `ai/chat.ts`, `ai/gemini.ts` (fallback parser and matcher). The chat prompt has no tools and treats the snapshot as data; the demo replies' maths is right.
- [x] Run 11 — chain mirror and recovery: `services/reconcile.ts`, `vault/recovery.ts`, `indexer.ts` (sync loop), and `chain.ts` `getState`. **No bugs confirmed.** Checked: reconcile re-reads under the pouch lock before it writes; the transaction journal never re-signs, and a preflight refusal is final only on the first broadcast of an unseen signature; the indexer keeps the same cursor on incomplete RPC data and runs one sync at a time. The design choice that an expired, unseen transaction stays `PaymentPending` ("needs review") until someone resolves it is noted, but it's documented, so not counted as a bug.
- [x] Run 12 — pouch routes: `routes/pouches.ts` (create, rules, freeze, unfreeze, freeze-all) against `vault/chain.ts` and `vault/mock.ts`.
- [x] Run 13 — Instacart and fulfillment: `services/instacart.ts`, `services/fulfillment.ts`, `routes/orders.ts:27-41`. **No bugs confirmed.** The URL allowlist (https only, no credentials or port, only instacart hosts, `redirect: "error"`) holds up, and links are reused only while unexpired and invalidated on edit. Two notes, not bugs: the provider call (up to 8s) runs while holding the pouch lock, so it briefly blocks other operations on that pouch; and items the store couldn't find are left off the Instacart list.
- [x] Run 14 — profile, stats and merchants routes: `routes/profile.ts`, `routes/stats.ts`, `routes/merchants.ts`, `updateUser` in both stores. **No bugs confirmed.** Checked: a PATCH leaves untouched fields alone (undefined is skipped, null clears) in both stores, so a concurrent wallet link isn't overwritten; the avatar regex accepts only png/jpeg/webp data URLs (no SVG); spend stats deduplicate indexed payments against paid orders, and the JS `spendBucket` and Timescale `time_bucket` both align to UTC midnight and hour.
- [x] Run 15 — web order page actions (order/page.tsx act()) and ChatOrderCards + demoCheckout service: no new confirmed bugs. The "Prepare devnet demo checkout" button shows even when demo mode is off, but the server answers 503 "Demo checkout is not enabled" and the card shows that message, so it degrades cleanly.
- [x] Run 16 — chat route (`routes/chat.ts`, `ai/chat.ts`, ChatWidget send path): 1 bug (#15). Temp test run, then deleted.
- [x] Run 17 — web API client (`apps/web/src/lib/api.ts`): no new bugs. The error-code map matches every program error the backend raises (`errors.rs`, `chain.ts:60`), 401 handling only clears the session when the token is unchanged, and a 30s timeout on a write shows "couldn't confirm the result" rather than claiming failure. Note: `cancel` sends no `version`, unlike `confirm`/`editOrder`. It is owner-only, so it isn't treated as a bug.
- [x] Run 18 — rate limiter (`security/rateLimit.ts`, wiring in `app.ts:56-67`): no new bugs. `clientIp` trusts forwarded headers only from configured peers and walks X-Forwarded-For from the right. `.env` trusts loopback with `cf-connecting-ip` for cloudflared. The per-IP limits (`write` 30/min, `voice` 60/min) are shared by every user whose voice tool calls come from the same ElevenLabs egress IP. That is covered by bug #5's shared-bucket note.
- [x] Run 19 — web PouchForm (`components/PouchForm.tsx`, create and edit rules): 1 bug (#16). Temp test run, then deleted.
- [x] Run 20 — Postgres store (`store/postgres.ts`: advisory-lock `lock()`, `query()`, `applyMockOperation`, `deleteAccount` transactions, rate-limit upsert): no new bugs, by reading only (no Postgres instance available). Transactions run on the client that holds the lock through AsyncLocalStorage, so BEGIN/COMMIT share one connection. Nested locks reuse the client and share a failure flag, and a client with unknown lock state is destroyed rather than returned to the pool. Lock contention times out with a 409, not a deadlock.
- [x] Run 21 — `vault/synced.ts` (chain-mode wrapper) and `ai/findOnline.ts`: **retracted bug #14**, because the wrapper writes `frozen` into the mirror after freeze/unfreeze. The wrapper's top-up, withdraw and pay refresh errors are swallowed on purpose (the chain is authoritative and startup reconciles it). In `findOnline.ts`: 1 bug (#17), verified with a temp test that was then deleted.
- [x] Run 22 — `services/request-constraints.ts` (price-cap parser) and `services/metrics.ts`: 1 bug (#18), verified with a temp test that was then deleted. metrics.ts is fine: it never throws and skips demo prices.
- [x] Run 23 — web auth (`components/AuthProvider.tsx`, `lib/session.ts`): no new bugs. Stale `/auth/me` and Google-credential responses are dropped by `authGeneration` and token checks. Sign-out clears local state before the network call, and other tabs sync through the `storage` event. A logout 401 cannot clear a newer session, because `authFetch` compares the request token with the current one.
- [x] Run 24 — web order lists (`components/OrderList.tsx`, used by `dashboard/page.tsx:224` and `orders/page.tsx:107`): 1 bug (#19).
- [x] Run 25 — web `components/AccountAlerts.tsx` and the dashboard overview totals (`dashboard/page.tsx:96-101`): no new bugs. Alerts are scoped per account, stale ticks are dropped by token checks, and the 80% budget alert id uses the UTC day, matching the UTC spend window. Note: an alert shown once is never shown again in later visits, even while it is still active. That is intentional "new alert" behaviour, not a bug.
- [x] Run 26 — SessionManager.tsx (session list, revoke, sign-out buttons): request-scope guards stale loads, revoke reloads only for the same session. No bugs.

## Confirmed bugs

### 1. Drafts get routed to a frozen pouch when that pouch names the store (Medium)
- **Where:** `apps/backend/src/services/orders.ts:167` (`pickCatalogPouch`); same pattern on the web path at `:201`.
- **What:** with no pouch named, the catalog path takes the first pouch whose allowlist includes the merchant, **without checking `frozen`**. The any-store fallback does check `!p.frozen`, so the two are inconsistent.
- **Repro (verified with a throwaway vitest):** pouches `[{id:"frozen-mm", allowedMerchantIds:["mountain-market"], frozen:true}, {id:"any", allowedMerchantIds:[], frozen:false}]`, then `createDraft(deps, email, "2 eggs")` → draft lands on `frozen-mm`.
- **Impact:** the user approves the cart, the vault rejects it as frozen, and the order becomes `rejected`, even though an unfrozen pouch could have paid. Voice ordering ("buy eggs") hits this whenever an old pouch is frozen.

### 2. Free top-ups from the shared treasury, which can then be withdrawn to your own wallet (High if real money is meant to work, Medium for a devnet-only demo)
- **Where:** `apps/backend/src/routes/topups.ts:250-271` and `services/topups.ts:182` → `vault/chain.ts:262-277`.
- **What:** `POST /topups` needs only a signed-in account with a linked wallet. No payment is taken. `completeTopUp` moves `amount` (up to $10,000 per top-up) from the **backend owner's** token account into the pouch, or mints it when `ENABLE_DEVNET_FAUCET=true`. `fromWallet` is only recorded for audit and is never debited (see the comment at `topups.ts:254`).
- **Repro:** sign in, link any wallet, `POST /topups {pouchId, amount: 10000000000}`, wait out the cooldown (5s by default), then `POST /topups/:id/complete` → the pouch has $10k. The rate limit allows 5 a minute, so about $50k/min per IP. Then `POST /withdrawals` sends it to your linked wallet after the hold (7 days by default, set by `WITHDRAW_HOLD_SECONDS`).
- **Impact:** any user can drain the shared treasury that funds everyone's pouches, or spend free balance at merchants. It also bypasses the Stripe/Transak real-money funding entirely. If those are meant to be the only way in, this route needs to be disabled or gated in production.

### 3. A bad `TOPUP_COOLDOWN_SECONDS` crashes top-up creation with a 500 (Low, config only)
- **Where:** `apps/backend/src/routes/topups.ts:258,267`.
- **What:** `Number(env)` isn't validated. A non-numeric value gives `NaN`, and `new Date(NaN).toISOString()` throws `RangeError` (a 500). A negative value silently removes the cooldown, which is the friction feature. Compare `withdrawHoldSeconds()` in `routes/withdrawals.ts:78`, which validates and returns a clean 503.
- **Repro:** `TOPUP_COOLDOWN_SECONDS=abc`, then `POST /topups` → 500.

### 4. Voice tools return bare HTTP errors with no `say`, so the agent has nothing to speak (Medium for the demo)
- **Where:** `apps/backend/src/routes/voice.ts:143-146` (`cancel_order` has no try/catch), `:123` (`getOwnedOrder` runs outside the try), `:137-140` (an `HttpError` **without** a `code` is rethrown). Compare `create_order` at `:109-111`, which turns every `HttpError` into `{say}`.
- **Repro (verified with a throwaway vitest on the in-memory app):** create an order by voice, then:
  - `cancel_order` twice → second call returns `409 {"error":"Order is cancelled, not draft"}`
  - `confirm_order` on that cancelled order → `409 {"error":"Order is cancelled"}`
  - `confirm_order {orderId:"nope"}` → `404 {"error":"Order not found"}`
- **Impact:** ElevenLabs sees a failed tool call with no `say` text, so the agent improvises. "Cancel that" on an order that already auto-paid or was paid is the worst case: the user may hear it was cancelled when money already moved. Codeless confirm failures (`Order total does not match its items` 422, `Merchant not found` 404) take the same path.

### 5. Voice-secret lockout doesn't stop a correct guess (Low)
- **Where:** `apps/backend/src/routes/voice.ts:64-69`.
- **What:** the failure budget is only checked on the **failure** path. After 10 wrong secrets, more wrong guesses get 429 instead of 401, but a correct secret is still accepted straight away. The lockout therefore doesn't slow brute force. Only the general `/voice` rate limit (60/min) does. With a long random secret this is low risk.
- **Related:** behind cloudflared without `TRUSTED_PROXY_IPS`, `clientIp` returns the tunnel's local address, so every caller shares one lockout bucket.

### 6. Card-funded money never reaches a pouch (High for the "real money" story)
- **Where:** `apps/backend/src/stripe/mint.ts:62-66` mints test-USDC to the **user's linked wallet** ATA. `vault/chain.ts:265,275` `topUp` debits the **backend owner's** ATA. The only deposit that would move money from the user's wallet into a pouch, `vault/ownerTransactions.ts`, is "not mounted in the API" (its header comment says so).
- **Repro:** pay $10 CAD through Stripe test checkout → the request becomes `confirmed` and 7.30 test-USDC lands in the user's wallet. The pouch balance doesn't change. A later `/topups` takes funds from the server's wallet, not the user's.
- **Impact:** paying adds nothing to what the user can spend, while free top-ups (bug 2) do. Paid funding and pouch balances aren't connected.

### 7. Wrong devnet genesis hash in the wallet deposit/withdraw builder (Low now, blocks the fix for bug 6)
- **Where:** `apps/backend/src/vault/ownerTransactions.ts:10`: `"EtWTRABZaYq6iMfeYKouRu166VU2xqa1"` is cut short. The real hash is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (correct in `stripe/mint.ts:11`).
- **Repro:** call `prepareOwnerTransfer` against a real devnet RPC → `getGenesisHash()` never equals the constant, so it always throws "The RPC network does not match devnet". The unit tests miss it because they stub the genesis hash.
- **Impact:** none today because it isn't mounted, but it breaks the moment someone wires it up.

### 8. Wrong mainnet genesis hash in the USDC receipt verifier (Low, same pattern as bug 7)
- **Where:** `apps/backend/src/funding/verification.ts:13`: `'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'` is cut to 32 characters. The real mainnet hash is `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
- **Repro:** `verifyMainnetUsdcReceipt` against a real mainnet RPC always throws "Mainnet receipt verification requires a mainnet RPC". `test/funding.test.ts:75` stubs the same short string, so the test passes.
- **Impact:** none today because only tests call it, but real-money receipt checks fail the day they're turned on. It's worth grepping for other 32-character genesis constants; both truncations look like copy-paste from one source.

### 9. "Save as list" always fails when the cart has an item the store couldn't find (Low)
- `apps/web/src/app/order/CartEditor.tsx:53` builds the list items as `{name, qty: line.qty}`. Unmatched lines always have `qty: 0` (`services/orders.ts:206`, `ai/gemini.ts:321`), but `routes/shoppingLists.ts:9` requires `qty >= 1`.
- Repro: create a draft where one item isn't found (e.g. "2 milk, 1 unobtainium"), type a list name, and click "Save as list". The response is 400 with the raw zod text `items.1.qty: Number must be greater than or equal to 1`. The existing assertion at `test/shopping.test.ts:28` (a quantity of 0 gives 400) shows that the server rejects it.
- Impact: you can't save the list unless you first edit the missing item out of the cart, and the error is unreadable. A fix would use `line.requestedQty`, or skip unmatched lines.

### 10. In the cart editor, a cart with an unmatched item blocks saving until the item is removed, and the UI doesn't say why (Low)
- `CartEditor.tsx:9` starts each unmatched line at `qty: 0`. The Save button is disabled while any line has a quantity below 1 (`:50`), with no message about which line.
- If the user raises that line to 1 or more, `services/shopping.ts:28-29` looks up `catalog.find(p => p.id === undefined)` and returns 422 "This item is unavailable".
- Repro: create a draft with one item that isn't found, and change the quantity of a *different* item. Save stays greyed out. The only way through is to click Remove on the unmatched line, which isn't explained.

### 11. In demo mode, a spoken order for something *under* a limit gets the "over $30" refusal (Medium for the stage demo, none outside it)
- `services/demoScript.ts:31`: `/(?:over|above|more|thirty|30)/i` matches "more" and "thirty" anywhere in the request, so any voice request containing those words becomes "McDonald's order for over $30" and gets `SCRIPT_OVER_30_SAY`.
- Verified with a temporary vitest (since deleted). Each of these returned `over30`:
  - "McDonald's, no more than fifteen dollars"
  - "get me a big mac for under thirty bucks"
  - "McDonald's under $15 and a Coke, nothing more"
- Impact: the happy-path demo line can turn into the refusal on stage, depending on wording. `test/demo-script.test.ts:44-45` only covers "50 novels" and "more than thirty".

### 12. In demo mode, the scripted draft can go to a pouch that can't pay it, matched only by pouch name (Low, demo only)
- `services/demoScript.ts:45` picks the first unfrozen pouch whose *name* matches `/uber|mcdonald/i`, even if its allowlist has no food domain. That comes before the any-store fallback. `:48` then sets the merchant to `web:ubereats.com`, which that pouch doesn't allow.
- An explicit `pouchId` (`:43-44`) is used the same way, with no allowlist or frozen check.
- Repro: create a pouch named "Uber" that allows only `web:amazon.com`, plus an any-store pouch, then say "McDonald's under 15". The draft lands on "Uber", and `prepareDemoCheckout` (`demoCheckout.ts:42`) returns 422 MerchantNotAllowed instead of using the any-store pouch.

### 13. The no-AI fallback parser sends requests to the wrong pouch on substring matches, and leaves "dollars" in item names (Low, fallback path only)
- `ai/gemini.ts:278-282`: the pouch hint regexes have no word boundaries. `/kim|job|material|lumber|stud|screw/` matches "**stud**y", "**kim**chi" and "**job**s". `services/orders.ts:141` then picks the pouch whose name includes the hint, which limits the catalog to that pouch's stores.
- `ai/gemini.ts:258` only strips price caps written as `$15` or `15`, so "under 15 dollars" leaves "dollars" in the item name.
- Verified with a temporary vitest (since deleted):
  - `fallbackParse("2 study lamps")` returns `pouchHint: "kim job: materials"`.
  - `fallbackParse("milk under 15 dollars")` returns the item `"milk   dollars"`.
- This only applies when Gemini or Claude parsing fails or isn't configured (`gemini.ts:152,188`). No catalog product has "and" in its name, so splitting "mac and cheese" into two items doesn't currently cost a match.

### 14. ~~In chain mode, Freeze/Unfreeze on a single pouch returns the old `frozen` value~~ RETRACTED in run 21, not a bug
- I filed this in run 12 after reading `ChainVaultClient.ownerOnly` (`vault/chain.ts:318-329`) on its own. In production chain mode, `apps/backend/src/index.ts:35` wraps the chain client in `SyncedVaultClient`. Its `freeze`/`unfreeze` (`vault/synced.ts:54-64`) call `markFrozen` (`:66-73`), which refreshes from the chain and writes `frozen` into the store, falling back to a direct write if the refresh fails. That happens before the route reads the mirror, so the response and later auto-pay and pouch-selection decisions see the new value. Kept here so the numbering stays stable.

### 15. Chat history the schema accepts is rejected by the global 64KB body limit (Low)
- **Where:** `apps/backend/src/app.ts:48` sets a global `bodyLimit` of 64KB on `*`, and it runs before `apps/backend/src/routes/chat.ts:22`'s own 192,000-byte limit. The route limit is never reached. The schema at `chat.ts:10-17` allows 20 messages of 2000 characters. The client, `apps/web/src/components/ChatWidget.tsx:354-356`, sends up to 19 messages plus 1, each cut to 2000 *characters*, not bytes.
- **Repro (verified with a temp vitest test):** POST `/chat` with 20 schema-valid messages of 2000 CJK characters each (120,639 bytes). The response is `413 {"error":"Request body too large"}`, not a reply. Any non-ASCII-heavy conversation (CJK, emoji, Arabic, …) passes 64KB long before 20 turns. After that, every send fails with "Request body too large" and only clearing the chat recovers.
- **Severity:** Low. English chats stay well under the limit, but non-English users get a chat that dead-ends. The 192KB route limit shows 64KB was not the intended cap.

### 16. Pouch limits over $10,000 fail with a raw micro-unit validation message (Low)
- **Where:** `apps/web/src/components/PouchForm.tsx:102-106` only checks that each amount is finite, not negative and a safe integer in micros. The inputs at `:195-205` have `min`/`step` but no `max`. The backend caps every rule at `10_000_000_000` micros ($10,000) in `apps/backend/src/routes/pouches.ts:12-14`, and `app.ts:110-112` returns the raw Zod issue text.
- **Repro (verified with a temp vitest test):** Create a pouch with a limit per order and a daily limit of 20000. The response is `400 {"error":"maxPerOrder: Number must be less than or equal to 10000000000; dailyLimit: Number must be less than or equal to 10000000000"}`, and the form shows that string. It uses internal field names and micro-USDC units, so a user can't tell the real cap is $10,000. The same applies to editing rules.
- **Severity:** Low. No bad state results, but the error can't be acted on.

### 17. Online price parser turns "6,49" into $649 and "2 for $9.00" into $29 (Low)
- **Where:** `apps/backend/src/ai/findOnline.ts:89`: `Number(String(m?.unitPrice ?? m?.price ?? "").replace(/[^0-9.]/g, ""))` strips every non-digit or dot character, so commas and words vanish instead of failing. The result is then clamped to at most 99,999.99 (`:96`) and kept.
- **Repro (verified, `validateFind` called directly in a temp test):** a model item `{unitPrice: "6,49"}` becomes `unitPrice 649`. `{unitPrice: "2 for $9.00"}` becomes `29`. The prompt asks for a number, but grounded Gemini or Claude output often returns strings like these, especially from French-Canadian retailer pages (`6,49 $`). The lookup is told to prefer Canada.
- **Impact:** the estimate is 100× or 3× too high. That can push a CAD reference cart over the pouch's per-order or daily limit (a false refusal). A devnet demo checkout prepared from it charges the inflated converted amount in test-USDC. These are estimates and no real retailer purchase is made, so the severity is Low.
- The match fallback at `:87-88` (`?? rawItems[i]`) also pairs items by position whenever the model rewrites the `requested` text, so a skipped item can shift prices onto the wrong product.

### 18. Price-cap parser reads "up to 2 or 3 apples" and "within 2 or 3 days" as a $2 limit (Low)
- **Where:** `apps/backend/src/services/request-constraints.ts:20`. `BARE_END` accepts a bare number followed by ` or`/` and`/` for`/` at`/… as a price, so `LEAD` words that also describe quantity or time (`up to`, `within`, `at most`, `max`) turn counts into dollars.
- **Repro (verified with a temp test):** `parseRequestConstraints("get me up to 2 or 3 apples")` and `("buy milk and eggs within 2 or 3 days")` both return `{maxPrice: 2000000, hasConstraint: true}`. In `services/orders.ts:106-110`, any cart over $2 then gets a line note "Over your limit of $2.00: this order totals $X", and `:89` turns auto-pay off for that order.
- **Severity:** Low. It fails safe, since it only adds approval and a wrong note, but the user sees a limit they never set. A related case, `"6 eggs, max 2 per customer"`, is read as a $2 per-item cap (`perItem`), which is harmless.

### 19. Order lists show CAD retailer estimates as USD amounts (Low)
- **Where:** `apps/web/src/components/OrderList.tsx:58` renders every row as `usd(toUsdc(o.total))`, and `components/ui.tsx:42-45` formats that as `Intl` currency `USD`. It never calls `orderCurrency`/`isCheckoutReference` from `@solpouch/shared` (`packages/shared/src/index.ts:114-125`), which ChatOrderCards (`ChatOrderCards.tsx:75-76`) and the order page use to label these carts "CAD estimate".
- **Repro:** Create an any-store or web-retailer cart, such as an online-search order priced in CAD. On `/dashboard` (recent orders) and `/orders` the row shows e.g. `$42.00` with status "Awaiting review", which reads as a USD/USDC amount waiting to be paid. The same order in the chat card says `42.00 CAD estimate` with "No retailer purchase is confirmed."
- **Severity:** Low, a display issue. No payment uses this value, but the main order list misstates the currency and implies the estimate can be paid through Solpouch, which the app goes out of its way to deny elsewhere.

### 20. Live site calls the backend at http://localhost:8787, so Google sign-in fails on phones (Critical)
Reported by Tariq on an iPhone (screenshot at 02:08). The Google account picker works, then the page shows "We couldn't connect to Solpouch. Check your connection and try again."
- That message is the `TypeError` (network failure) branch of `apps/web/src/components/AuthProvider.tsx:131-146`, from the POST to `${BACKEND_URL}/auth/google`.
- `BACKEND_URL` falls back to `http://localhost:8787` when `NEXT_PUBLIC_BACKEND_URL` isn't set at build time (`apps/web/src/lib/api.ts:19`, and the CSP in `apps/web/src/proxy.ts:10`).
- Verified live: `curl -sD - https://solpouch.tech/` returns a CSP with `connect-src 'self' http://localhost:8787 …`. Production was built without `NEXT_PUBLIC_BACKEND_URL`.
- On a phone, or any machine not running the backend, `localhost` is that device, so the sign-in POST and every other API call fail. It probably looked fine on a laptop running the backend locally. HTTPS→http mixed content blocks it in most browsers anyway.
Repro: open https://solpouch.tech on a phone → Sign in with Google → pick an account → see the error above.
Severity: Critical. Nobody outside the dev machine can sign in or use the app.
Also: the fallback should fail the production build rather than quietly defaulting to localhost.

## Checked, not bugs
- `POST /orders/:id/confirm` without `version` always returns 409 (`routes/orders.ts:424` defaults to -1). This is deliberate: `test/shopping.test.ts:54` asserts it, and the web client always sends a version.
- Re-confirming a paid order calls `recordPaidOrder` again, but payments are deduplicated on (tx, order) in both stores.
- On-chain, `withdraw` and `close_pouch` still work while a pouch is frozen. That's right: freezing only stops the agent's `pay`, and the owner must be able to drain a pouch.
- Closing and re-creating a pouch resets `spent_today`, but only the owner can do that, so it isn't a way around the limits. The backend uses the 32-hex pouch id as the PDA name seed, not the 60-character display name, so the 32-byte seed limit never applies to display names.
- Chat: a blank or whitespace-only message anywhere in the history makes `/chat` return 400 (`messages.N.content: String must contain at least 1 character(s)`, verified), and ChatWidget.tsx:122-125 appends voice transcripts without checking for blanks. That would poison the chat until the blank scrolls out, but only if the voice provider ever sends an empty transcript, which I can't confirm. Recorded as a risk, not a bug.
