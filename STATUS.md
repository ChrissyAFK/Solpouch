# Status

Current local integration: `codex/integrate-audit` combines shopping/funding work with `fix/audit-2`. See [AUDIT_INTEGRATION.md](docs/AUDIT_INTEGRATION.md) for corrections and current verification. Nothing from this integration has been pushed or deployed.

US/Canada wallet funding has a gated staging integration on `codex/bank-funding`. See [BANK_FUNDING.md](docs/BANK_FUNDING.md) for setup, verification boundaries and the remaining mainnet work. No live bank transfers or automatic pouch credits are enabled.

Current audit fixes and local verification are tracked in `docs/AUDIT_FIXES.md`. Historical deployment observations below are not proof of the current live environment.

Dashboard redesign from `codex/dashboard-design` is merged into `scaffold` (not merged to main).

## Backend hardening branch (2026-10-03)

Wallet sign-in, server-side ownership, scoped voice credentials, versioned storage, shared rate limits, verified database TLS, read-only startup, and journaled payment retries are implemented. See [BACKEND-HARDENING.md](BACKEND-HARDENING.md) for migration and recovery steps. Existing pouches stay hidden until an operator assigns their verified owner. This is a devnet, single-owner chain adapter; it does not implement production multi-wallet signing.

Local automated checks pass for auth, isolation, concurrency and simulated failure/restart recovery. Ten real PostgreSQL relational integration checks now pass, including a database process restart; Timescale-specific migration and funded devnet verification remain outstanding. Authenticated ElevenLabs text/Talk session support is implemented behind the provider-configuration gate; live identity integration awaits the collaborator’s deployed source. The domain deployment is unchanged by this branch.

The historical integration notes below describe the earlier deployment, not the hardened branch's runtime verification.

## Done

| Part | Where | Verified |
|---|---|---|
| API contract | `packages/shared/src/index.ts` | typecheck |
| Backend (Hono, Postgres or in-memory store, chain or mock vault, Gemini + offline fallback, friction top-ups, voice webhooks) | `apps/backend` | typecheck, 37 vitest tests |
| Vault program (Anchor 1.2), program ID `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` | `programs/solpouch_vault` | `anchor build` (IDL in `target/idl`), 8 unit tests, 10 integration tests on a local validator |
| Voice agent config | `voice/` | n/a (set up in the ElevenLabs dashboard) |
| Web dashboard (Next.js: pouches, rules, friction top-up, cart review, spend chart) | `apps/web` | production build, typecheck, local browser checks |

## Hooked up (2026-10-03)

- Devnet: program deployed at `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` (upgrade authority = the dev wallet, `ED426nu…R52i`). Test-USDC mint `CiXLdY9HrDvBb7x3XfiqGjCHCrf31SmVDEQp3kJ6Z4Mf` (6 decimals, mint authority = same wallet). The program keypair (`target/deploy/solpouch_vault-keypair.json`) is only on the deployer's machine: share it privately, never commit it.
- Tiger Data: free service `solpouch` (us-east-1), connection string in `.env` `DATABASE_URL`.
- ElevenLabs agent `agent_5201m41wvxthe08tk6nm81391sss`: prompt from `voice/prompt.md`, Gemini 2.5 Flash, 5 webhook tools (POST, header `X-Solpouch-Secret` from workspace secret, synced to `.env` `ELEVENLABS_TOOL_SECRET`). No-arg tools carry an optional `note` field because ElevenLabs requires a body schema on POST.
- Tool URLs point at a cloudflared quick tunnel, which changes on every restart. After a restart, rerun the tool setup with the new URL, or move to a named tunnel on solpouch.tech.

- Backend runs on Tiger Postgres (`apps/backend/src/store/postgres.ts`, schema applied and seeded on start) with `VAULT_MODE=chain`: on start it only reads existing pouch state from the chain; it never creates or funds pouches automatically, and `vault/synced.ts` mirrors balance, spentToday and frozen back into the store after every write. Signers come from `.keys/owner.json` and `.keys/agent.json` (gitignored). The backend signs owner actions only for the demo; in production the owner signs in their wallet.
- Verified end to end on 2026-10-03: a draft order is confirmed with a real devnet tx and the balance syncs; freeze and unfreeze work; the voice webhook via the tunnel answers with the secret and returns 401 without it. A voice call in the ElevenLabs Preview (Mock tools off) reads live balances.

## Abuse protection (2026-10-03)

- Backend limits use persistent Store counters. Forwarded client addresses are accepted only from configured `TRUSTED_PROXY_IPS`, using `TRUSTED_PROXY_HEADER`. AI calls share a per-account minute/day budget across chat, orders and voice. The 64KB body limit, CORS and secure headers remain. Repeated invalid voice secrets are rate-limited. A header's mere presence no longer identifies trusted tunnel traffic; restrict exposed paths at the actual ingress when needed.
- ElevenLabs agent: origin allowlist (localhost, solpouch.tech, www.solpouch.tech), Origin header required, 5 concurrent calls, 300 a day, 5-minute calls, hang up after 30s of silence.
- The backend no longer seeds placeholder pouches on start (tests still use `seedPouches()`).

## Google sign-in and solpouch.tech (2026-10-03)

- Sign in with Google (Identity Services ID token). The backend verifies it against Google's keys (`GOOGLE_CLIENT_ID`, verified email only) and issues a 7-day JWT referencing a persisted, revocable session (`SESSION_SECRET`). Old stateless tokens require signing in again. Pouches, orders, top-ups, stats and chat are scoped to the signed-in email; other users' items return 404. `LEGACY_OWNER_EMAIL` in `.env` owns pouches created before sign-in.
- Voice: the web app fetches a 15-minute voice token (`POST /auth/voice-token`) and passes it to the ElevenLabs agent as the `user_token` dynamic variable; every voice tool requires it and verifies that its parent session is still active. Signing out or revoking the parent invalidates voice tools immediately.
- Production requires `SESSION_SECRET` and `ELEVENLABS_TOOL_SECRET`.
- The site needs `Cross-Origin-Opener-Policy: same-origin-allow-popups`, or the Google popup hangs blank on `/gsi/transform`.
- Live at https://solpouch.tech through the named Cloudflare tunnel `solpouch` (`api.solpouch.tech` -> :8787, site -> the production `next start` port). Voice tool URLs use `https://api.solpouch.tech/voice/tools/<name>`.

## Historical audit branch report (2026-10-03, branch `fix/audit`)

The integration report above supersedes this branch report. In particular, an expired transaction with missing RPC history remains uncertain and must not be treated as a proven failure.

Fixes from the whole-project audit. Checks: backend 153 tests and typecheck, web typecheck and CSP test, `cargo test` 10. Not run: Anchor integration tests (need a local validator), Postgres integration tests, and a browser pass over the chat widget and top-up flow.

- Chain client: `CHECKOUT_PAY_TO` must be a real devnet wallet in `.env`. Without it the backend starts with a warning and any-store / web-store orders are rejected. Chain errors that can never succeed (pouch not on chain, wrong AI key, signer out of SOL, failed or expired transaction) now end the order as rejected instead of leaving it `paying`. `freeze_all` and reconcile carry on past a failing pouch. Startup warns when the AI key holds under 0.05 SOL (each receipt costs it about 0.0015 SOL).
- Orders: Postgres stores `order.store` and `order.fulfillment` (additive columns). A failed AI lookup returns 503 `LookupFailed` instead of an invented draft; this also applies with no AI key at all. Confirm re-checks the pouch's store list. Voice `confirm_order` refuses a draft younger than 4 seconds.
- Top-ups: new `failed` status with `failReason`; `GET /topups` also lists `processing` and recently failed ones; completing re-checks the linked wallet.
- Users: profile and wallet-link updates no longer overwrite each other; the in-memory store enforces one wallet per account.
- AI and voice: store URLs must be https on the found domain, Gemini calls time out, quantities are clamped, voice `create_order` is rate limited, 10 wrong voice secrets lock an IP out for 10 minutes.
- Web: order page picks up voice-created drafts, top-up cooldown tolerates clock skew, chat widget Talk works after typing and sign-out ends the session. The ElevenLabs audio worklets were tested under the production CSP in headless Chrome and load fine (`apps/web/test/worklet-csp.browser.mjs`, needs `PLAYWRIGHT_MODULE`).
- Vault program (source only, NOT redeployed): rejects zero amounts, the AI key as an allowed merchant and duplicate merchants (errors 6009-6011); `close_pouch` sweeps leftover tokens to a new `owner_token` account. After a redeploy, regenerate the IDL (`apps/backend/src/vault/idl`), since the `close_pouch` entry there still describes the deployed version.

Second pass (branch `fix/audit-2`, built in the `Solpouch-fix` worktree; backend 164 tests, typechecks and CSP test pass; the new SQL has not run against a real Timescale database and nothing was checked in a browser):

- Indexer (`apps/backend/src/indexer.ts`, started in chain mode from `src/index.ts`): backfills paid orders into the Tiger `payments` hypertable, then follows the program's `PaymentMade` logs, including payments sent from outside the app. A paid order also writes `payments` and `prices` rows directly. `GET /stats/spend` reads `payments` with `time_bucket` and falls back to the orders table when the series is empty or the query fails.
- `spentToday` follows the chain's rolling 24 hours (`pouches.spent_since`, additive column).
- `confirmAbove`: 0 asks before every order; above 0, orders at or under it skip the 4-second voice wait (still a separate confirm call, nothing auto-pays). The pouch form has an "Ask before paying" field. `voice/prompt.md` gained one sentence; the live ElevenLabs agent prompt has not been re-synced.

Still open from the audit: `apps/web/test/auth-voice.browser.mjs` still drives the old wallet-login flow. The production backend runs `tsx watch` from this checkout, so saving a backend file reloads the live API.

## Not done yet

- Wallet sign-in for owner actions (the backend still signs owner txs for the demo).
- Production multi-wallet transaction signing and authenticated voice provider binding remain to be built.
- Chain indexer (`apps/backend/src/indexer.ts`, `ENABLE_INDEXER=true`, chain mode + Postgres only) is unit-tested against fixture logs and a fake RPC, but has not been run against devnet or Tiger Data; the new schema (`vault_events`, `indexer_cursors`, real-time `spend_daily`) has not been applied to the live database yet.
- `confirmAbove` auto-pay works for exact catalog orders at or below the amount. The pouch form sets it as "Ask before paying" (empty or 0 asks before every order; it cannot exceed the limit per order). It is covered by tests only, not run against devnet. The updated `voice/prompt.md` (rule 8) must be copied to the ElevenLabs agent.
- `scripts/chain-smoke.ts` and `scripts/db-check.ts` are manual checks; `test/postgres.test.ts` runs only with `TEST_DATABASE_URL`.

## Run it

```
pnpm install
cp .env.example .env      # keys go here only, never in apps/web
pnpm dev:backend          # http://localhost:8787; no placeholder pouches seeded
pnpm dev:web              # http://localhost:3000
pnpm --filter @solpouch/backend test
cd programs/solpouch_vault && cargo test
```

Program build and tests run in WSL Ubuntu (Rust, Solana CLI 3.1, Anchor 1.2 via avm, Surfpool, Node 24 via nvm). Make sure Linux node comes before Windows node on PATH, or tests fail with `ANCHOR_PROVIDER_URL is not defined`:

```
anchor build
anchor test                       # Anchor.toml cluster is localnet; uses Surfpool by default
anchor test --validator legacy    # same, with solana-test-validator (no Surfpool needed)
anchor deploy --provider.cluster devnet   # devnet deploys are explicit; needs the upgrade authority
```

`[provider] cluster` is `localnet` so a plain `anchor test` can never deploy to devnet. Pass `--provider.cluster devnet` for any devnet command.

## Dashboard chat

Earlier deployment: the floating **Ask Solpouch** widget talked to the ElevenLabs agent (`NEXT_PUBLIC_ELEVENLABS_AGENT_ID`, public, not a key) over a websocket: typed messages use a text-only session, and **Talk** starts a voice call with the mic. If the agent connection fails, it falls back to the Gemini `/chat` route below. Verified 2026-10-03: a typed balance question returns live pouch balances.

The Gemini fallback uses the existing Gemini integration. Set `GEMINI_API_KEY` in the ignored root `.env` to enable model replies; `GEMINI_MODEL` optionally overrides the existing default model. Restart the backend after changing environment configuration. Keep keys on the backend.

Without a key, the widget explicitly shows **Demo mode** and offers limited responses based on current pouch data. The text-model fallback has no action tools. Account-backed cart cards display current orders and let the user explicitly approve catalog payments or check pending status. Instacart links hand off checkout without moving pouch funds. Conversation history stays in the current browser page session and resets on refresh.

## Mobile, metadata and page states

The mobile menu appears at 640px and below. Loading pages and retries use skeletons. Failed requests, missing pouches/orders, unexpected page errors, and unknown URLs have plain recovery messages. The footer leaves space for the chat button.

Every route has a title, description, Open Graph and Twitter preview. The app includes a branded favicon, Apple icon, manifest icons, social image, `/manifest.webmanifest`, `/robots.txt`, and `/sitemap.xml`.

Frontend settings are documented in `apps/web/.env.example`. Copy it to `apps/web/.env.local` or set the values in the frontend hosting environment; Next does not load the repository root `.env`. Set `SOLPOUCH_SITE_URL` to the actual deployed origin for canonical and social-image URLs. There is no production domain configured locally. The dashboard defaults to noindex and an empty sitemap. Only the public landing page should use `SOLPOUCH_ALLOW_INDEXING=true`; it takes effect in production with a non-local site URL. Dashboard, orders and pouch pages always remain noindex and are excluded from the sitemap. Crawler settings do not provide access control.

## Response headers

The frontend uses a fresh script nonce for each request and dynamic rendering, with private/no-store HTML caching. Production scripts do not allow inline code without a nonce or `eval`. The CSP permits connections to the configured `NEXT_PUBLIC_BACKEND_URL`; use an HTTPS backend with an HTTPS site. Inline styles remain allowed for React styles, progress bars and charts. Development additionally permits hot reload connections and eval. Framing, object embeds and inline event handlers are blocked. Headers also set MIME protection, referrer and browser-permission policies; HTTPS requests receive HSTS.

Check the policy with `pnpm --filter @solpouch/web test:security`. For the route/asset checks, run a production preview on port 3001 and `pnpm --filter @solpouch/web test:smoke` (or set `WEB_TEST_URL`). These checks assume the default private indexing settings.

## Landing page

The public product page lives at `/`. The existing demo overview moved to `/dashboard`; order and pouch URLs are unchanged. Navigation, recovery links, and private-page metadata point to the new dashboard route. The landing page uses illustrative pouch values and explains that payments are simulated. It does not require the backend to render.

- Combined auth: Google sign-in required for every data route (owner = email); a wallet is linked to the account for top-ups (POST /topups returns 403 without one).

## 2026-10-03 evening: web fixes (uncommitted on fix/audit)

- Production `next start` builds into its own folder via `SOLPOUCH_DIST_DIR` (`.next-prod-a` / `.next-prod-b`, alternating), so a dev build can no longer swap chunks under the live server.
- Ask Solpouch stays mounted across every page (Shell renders one ChatWidget at a fixed tree position); the launcher and Escape hide the panel, × ends the chat and voice call. The order link no longer closes it (except on phones, where it hides the panel).
- Order flow: `/order?request=` auto-builds a draft cart when exactly one pouch is usable (never pays); empty state links to /pouches; paid receipt links to /orders and the pouch.
- Devnet Explorer links for pouch address, top-ups and order receipts; top-up panel says it uses devnet demo funds.
- `POST /pouches/freeze-all` + dashboard "Freeze all pouches".
- Error messages: coded 5xx/503 server messages reach the user; contact email split so Cloudflare email obfuscation doesn't break hydration.
- Not done: delete/close pouch and withdraw (program `close_pouch` fix not redeployed, no vault/route/UI), wallet-signed top-ups, signed-in browser pass, live voice call check.

## 2026-10-03 night: everything merged and deployed (`scaffold` = `integrate/all`, 5ae2bc0)

- Merged into one line: `fix/audit` (chat persistence, order hand-off, withdrawals with a 7-day hold), `codex/integrate-audit` (includes `fix/audit-2`) and `integrate/next-steps` (program events and rule checks, event indexer, wallet linking, auto-pay within `confirmAbove`). Two review passes; every finding fixed.
- Auto-pay: only the web order form, only for a near-exact catalog match within `confirmAbove` and the per-order limit. Voice orders always need a spoken yes. All live pouches were reset to `confirm_above = 0` at deploy.
- Vault program upgraded in place on devnet (slot 507237576). Use `anchor upgrade --program-id <id> --provider.cluster devnet target/deploy/solpouch_vault.so`: `solana program deploy` rejects the SBPF v3 build, and `target/deploy` in a fresh worktree holds a new keypair, so plain `anchor deploy` would create a second program. The program account was extended by 16384 bytes first.
- Startup rule re-sync (push stored rules on chain when they differ) only runs with `RESYNC_RULES_ON_START=1`.
- Profile has a Preferences card: appearance (auto, light, dark), motion, text size, saved per browser under `solpouch.prefs`. The landing page stays dark (`.force-dark`).
- Production: backend `tsx watch` on 8787 and `next start` on 3019 from this checkout on `scaffold`; logs in `backend-run.log` and `web-run.log`.
- Not verified: the Preferences card and light theme on signed-in pages (no browser session), and a real payment to the new checkout wallet after the upgrade. `ENABLE_INDEXER` is still off. `main` is still behind `scaffold`.
