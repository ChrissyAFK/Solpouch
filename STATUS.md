# Status

Branch: `scaffold` (not merged to main yet).

## Done

| Part | Where | Verified |
|---|---|---|
| API contract | `packages/shared/src/index.ts` | typecheck |
| Backend (Hono, in-memory store, mock vault, Gemini + offline fallback, friction top-ups, voice webhooks) | `apps/backend` | typecheck, 15 vitest tests |
| Vault program (Anchor 1.2) | `programs/solpouch_vault` | `cargo check`, 8 unit tests in `logic.rs` |
| Voice agent config | `voice/` | n/a (set up in the ElevenLabs dashboard) |
| Web dashboard (Next.js: pouches, rules, friction top-up, cart review, spend chart) | `apps/web` | typecheck, build, pages return 200; flows not clicked through yet |

## In progress (none)


## Not done yet

- `anchor build` / deploy to devnet: needs the Solana + Anchor CLIs (WSL2 or Solana Playground). Then set `VAULT_PROGRAM_ID`, create the test-USDC mint, set `TEST_USDC_MINT`.
- `apps/backend/src/vault/chain.ts`: real client for the program (stub throws). Switch with `VAULT_MODE=chain`.
- `tests/solpouch_vault.ts`: Anchor integration tests, never run (need a local validator).
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
