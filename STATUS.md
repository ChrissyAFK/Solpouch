# Status

Dashboard redesign from `codex/dashboard-design` is merged into `scaffold` (not merged to main).

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

- Backend runs on Tiger Postgres (`apps/backend/src/store/postgres.ts`, schema applied and seeded on start) with `VAULT_MODE=chain`: on start it creates any missing pouch PDAs on devnet and funds them from the owner wallet (`ensureOnChain`), and `vault/synced.ts` mirrors balance, spentToday and frozen back into the store after every write. Signers come from `.keys/owner.json` and `.keys/agent.json` (gitignored). The backend signs owner actions only for the demo; in production the owner signs in their wallet.
- Verified end to end on 2026-10-03: a draft order is confirmed with a real devnet tx and the balance syncs; freeze and unfreeze work; the voice webhook via the tunnel answers with the secret and returns 401 without it. A voice call in the ElevenLabs Preview (Mock tools off) reads live balances.

## Abuse protection (2026-10-03)

- Backend (`apps/backend/src/security/rateLimit.ts`, `app.ts`): per-IP limits (all routes 120/min, writes 30/min, `/chat` and `POST /orders` 10/min and 200/day, top-ups 5/min, `/voice/*` 60/min), 64KB body limit, secure headers, CORS only for `WEB_ORIGINS` (default localhost:3000 and solpouch.tech). Requests that come through the Cloudflare tunnel can only reach `/health` and `/voice/*` unless `PUBLIC_API=all`. The voice secret is compared in constant time, and 10 wrong secrets lock an IP out for 10 minutes. Inputs are capped (names 60 chars, amounts 10,000 USDC, max 50 pouches).
- ElevenLabs agent: origin allowlist (localhost, solpouch.tech, www.solpouch.tech), Origin header required, 5 concurrent calls, 300 a day, 5-minute calls, hang up after 30s of silence.
- The backend no longer seeds placeholder pouches on start (tests still use `seedPouches()`).

## Not done yet

- No sign-in yet: anyone who can reach the backend directly can manage pouches. Wallet sign-in is the real fix.

- A permanent tunnel on solpouch.tech (the quick tunnel URL changes on restart).
- Indexer is a stub; `confirmAbove` is stored but not used for auto-confirm.
- `scripts/chain-smoke.ts` and `scripts/db-check.ts` are manual checks; `test/postgres.test.ts` runs only with `TEST_DATABASE_URL`.

## Run it

```
pnpm install
cp .env.example .env      # keys go here only, never in apps/web
pnpm dev:backend          # http://localhost:8787, works offline with seeded pouches
pnpm dev:web              # http://localhost:3000
pnpm --filter @solpouch/backend test
cd programs/solpouch_vault && cargo test
```

Program build and tests run in WSL Ubuntu (Rust, Solana CLI 3.1, Anchor 1.2 via avm, Surfpool, Node 24 via nvm). Make sure Linux node comes before Windows node on PATH, or tests fail with `ANCHOR_PROVIDER_URL is not defined`:

```
anchor build
anchor test --provider.cluster localnet
```

## Dashboard chat

The floating **Ask Solpouch** widget talks to the ElevenLabs agent (`NEXT_PUBLIC_ELEVENLABS_AGENT_ID`, public, not a key) over a websocket: typed messages use a text-only session, and **Talk** starts a voice call with the mic. If the agent connection fails, it falls back to the Gemini `/chat` route below. Verified 2026-10-03: a typed balance question returns live pouch balances.

The Gemini fallback uses the existing Gemini integration. Set `GEMINI_API_KEY` in the ignored root `.env` to enable model replies; `GEMINI_MODEL` optionally overrides the existing default model. Restart the backend after changing environment configuration. Keep keys on the backend.

Without a key, the widget explicitly shows **Demo mode** and offers limited responses based on current pouch data. Chat does not execute payments or change pouch rules. Shopping requests open the existing order form for review and approval. Conversation history stays in the current browser page session and resets on refresh.

## Mobile, metadata and page states

The mobile menu appears at 640px and below. Loading pages and retries use skeletons. Failed requests, missing pouches/orders, unexpected page errors, and unknown URLs have plain recovery messages. The footer leaves space for the chat button.

Every route has a title, description, Open Graph and Twitter preview. The app includes a branded favicon, Apple icon, manifest icons, social image, `/manifest.webmanifest`, `/robots.txt`, and `/sitemap.xml`.

Frontend settings are documented in `apps/web/.env.example`. Copy it to `apps/web/.env.local` or set the values in the frontend hosting environment; Next does not load the repository root `.env`. Set `SOLPOUCH_SITE_URL` to the actual deployed origin for canonical and social-image URLs. There is no production domain configured locally. The dashboard defaults to noindex and an empty sitemap. Only the public landing page should use `SOLPOUCH_ALLOW_INDEXING=true`; it takes effect in production with a non-local site URL. Dashboard, orders and pouch pages always remain noindex and are excluded from the sitemap. Crawler settings do not provide access control.

## Response headers

The frontend uses a fresh script nonce for each request and dynamic rendering, with private/no-store HTML caching. Production scripts do not allow inline code without a nonce or `eval`. The CSP permits connections to the configured `NEXT_PUBLIC_BACKEND_URL`; use an HTTPS backend with an HTTPS site. Inline styles remain allowed for React styles, progress bars and charts. Development additionally permits hot reload connections and eval. Framing, object embeds and inline event handlers are blocked. Headers also set MIME protection, referrer and browser-permission policies; HTTPS requests receive HSTS.

Check the policy with `pnpm --filter @solpouch/web test:security`. For the route/asset checks, run a production preview on port 3001 and `pnpm --filter @solpouch/web test:smoke` (or set `WEB_TEST_URL`). These checks assume the default private indexing settings.

## Landing page

The public product page lives at `/`. The existing demo overview moved to `/dashboard`; order and pouch URLs are unchanged. Navigation, recovery links, and private-page metadata point to the new dashboard route. The landing page uses illustrative pouch values and explains that payments are simulated. It does not require the backend to render.
