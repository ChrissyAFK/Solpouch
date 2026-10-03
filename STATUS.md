# Status

Dashboard work: `codex/dashboard-design`, based on `scaffold` (not merged to main).

## Done

| Part | Where | Verified |
|---|---|---|
| API contract | `packages/shared/src/index.ts` | typecheck |
| Backend (Hono, in-memory store, mock vault, Gemini + offline fallback, friction top-ups, voice webhooks) | `apps/backend` | typecheck, 30 vitest tests |
| Vault program (Anchor 1.2), program ID `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` | `programs/solpouch_vault` | `anchor build` (IDL in `target/idl`), 8 unit tests, 10 integration tests on a local validator |
| Voice agent config | `voice/` | n/a (set up in the ElevenLabs dashboard) |
| Web dashboard (Next.js: pouches, rules, friction top-up, cart review, spend chart) | `apps/web` | production build, typecheck, local browser checks |

## In progress (none)


## Not done yet

- Deploy to devnet: the deploy wallet needs about 2 devnet SOL (faucet.solana.com). Then `anchor deploy`, set `VAULT_PROGRAM_ID`, create the test-USDC mint, set `TEST_USDC_MINT`. The program keypair (`target/deploy/solpouch_vault-keypair.json`) is only on Tariq's machine: share it privately, never commit it.
- `apps/backend/src/vault/chain.ts`: real client for the program (stub throws). Switch with `VAULT_MODE=chain`.
- Postgres / Tiger Data: `apps/backend/db/schema.sql` exists, store is still in-memory. Indexer is a stub.
- Shared `VAULT_ERRORS` lacks `OrderAlreadyUsed`, which the mock vault emits.
- `confirmAbove` is stored but not used for auto-confirm.

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

The floating **Ask Solpouch** widget uses the existing Gemini integration. Set `GEMINI_API_KEY` in the ignored root `.env` to enable model replies; `GEMINI_MODEL` optionally overrides the existing default model. Restart the backend after changing environment configuration. Keep keys on the backend.

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
