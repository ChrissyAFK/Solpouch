# Status

Branch: `scaffold` (not merged to main yet).

## Done

| Part | Where | Verified |
|---|---|---|
| API contract | `packages/shared/src/index.ts` | typecheck |
| Backend (Hono, Postgres or in-memory store, chain or mock vault, Gemini + offline fallback, friction top-ups, voice webhooks) | `apps/backend` | typecheck, 15 vitest tests |
| Vault program (Anchor 1.2), program ID `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` | `programs/solpouch_vault` | `anchor build` (IDL in `target/idl`), 8 unit tests, 10 integration tests on a local validator |
| Voice agent config | `voice/` | n/a (set up in the ElevenLabs dashboard) |
| Web dashboard (Next.js: pouches, rules, friction top-up, cart review, spend chart) | `apps/web` | typecheck, build, pages return 200; flows not clicked through yet |

## Hooked up (2026-10-03)

- Devnet: program deployed at `AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F` (upgrade authority = the dev wallet, `ED426nu…R52i`). Test-USDC mint `CiXLdY9HrDvBb7x3XfiqGjCHCrf31SmVDEQp3kJ6Z4Mf` (6 decimals, mint authority = same wallet). The program keypair (`target/deploy/solpouch_vault-keypair.json`) is only on the deployer's machine: share it privately, never commit it.
- Tiger Data: free service `solpouch` (us-east-1), connection string in `.env` `DATABASE_URL`.
- ElevenLabs agent `agent_5201m41wvxthe08tk6nm81391sss`: prompt from `voice/prompt.md`, Gemini 2.5 Flash, 5 webhook tools (POST, header `X-Solpouch-Secret` from workspace secret, synced to `.env` `ELEVENLABS_TOOL_SECRET`). No-arg tools carry an optional `note` field because ElevenLabs requires a body schema on POST.
- Tool URLs point at a cloudflared quick tunnel, which changes on every restart. After a restart, rerun the tool setup with the new URL, or move to a named tunnel on solpouch.tech.

- Backend runs on Tiger Postgres (`apps/backend/src/store/postgres.ts`, schema applied and seeded on start) with `VAULT_MODE=chain`: on start it creates any missing pouch PDAs on devnet and funds them from the owner wallet (`ensureOnChain`), and `vault/synced.ts` mirrors balance, spentToday and frozen back into the store after every write. Signers come from `.keys/owner.json` and `.keys/agent.json` (gitignored). The backend signs owner actions only for the demo; in production the owner signs in their wallet.
- Verified end to end on 2026-10-03: a draft order is confirmed with a real devnet tx and the balance syncs; freeze and unfreeze work; the voice webhook via the tunnel answers with the secret and returns 401 without it. A voice call in the ElevenLabs Preview (Mock tools off) reads live balances.

## Not done yet

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
