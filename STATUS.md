# Status

Branch: `scaffold` (not merged to main yet).

## Done

| Part | Where | Verified |
|---|---|---|
| API contract | `packages/shared/src/index.ts` | typecheck |
| Backend (Hono, in-memory store, mock vault, Gemini + offline fallback, friction top-ups, voice webhooks) | `apps/backend` | typecheck, 15 vitest tests |
| Vault program (Anchor 1.2), program ID `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` | `programs/solpouch_vault` | `anchor build` (IDL in `target/idl`), 8 unit tests, 10 integration tests on a local validator |
| Voice agent config | `voice/` | n/a (set up in the ElevenLabs dashboard) |
| Web dashboard (Next.js: pouches, rules, friction top-up, cart review, spend chart) | `apps/web` | typecheck, build, pages return 200; flows not clicked through yet |

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
