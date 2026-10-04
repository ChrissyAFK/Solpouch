# Backend hardening

This branch requires Google sign-in for pouch, order, top-up, stats, chat and voice data. The API issues a session JWT that the web app keeps and sends as an `Authorization: Bearer` header; there are no cookies. Pouches are owned by the signed-in Google email; a linked wallet is used only for top-ups. Public landing pages and merchant catalogs remain available without signing in.

## Rollout

1. Back up the database and test the additive migration in `apps/backend/db/schema.sql` on a staging TimescaleDB database. Startup applies the schema; existing rows retain version 0 and no owner. Do not run old and new backend versions concurrently: the old version does not participate in ownership, locking or version checks.
2. Set `WEB_ORIGINS` to exact approved origins. CORS allows only those origins. Use HTTPS in production.
3. Remote Postgres certificates are verified. Set `DATABASE_CA_CERT` to a trusted PEM CA file if required. Plaintext is permitted only for an explicitly configured localhost database. Never copy production credentials into tests.
4. Review the actual owner of each legacy pouch. From the backend directory, with the intended `DATABASE_URL` set, run `pnpm exec tsx scripts/assign-owner.ts --pouch ID --email GOOGLE_EMAIL`. Inspect the dry-run output, then repeat with `--apply`. This administrative script refuses ownership reassignment. Signing in never claims old pouches automatically.
5. The current chain adapter remains a single-owner devnet demo. Google sign-in establishes account ownership; chain writes additionally require the account to link the configured demo owner wallet. The server still holds the demo owner/agent keys. Mainnet and multi-owner wallet transaction signing are not implemented. Chain startup requires persistent Postgres, checks devnet before signing, and performs no creates, refills or minting. `ENABLE_DEVNET_FAUCET=true` explicitly enables atomic test-token mint/deposit; leave it false to transfer existing tokens.
6. Configure proxy trust only if needed: `TRUSTED_PROXY_IPS` lists immediate socket addresses; `TRUSTED_PROXY_HEADER` is `x-forwarded-for` or `cf-connecting-ip`. The trusted proxy must overwrite it with one verified IP. Client-supplied headers and IP lists are ignored. Database-backed limits are shared between workers.
7. Run tests against staging, then a dedicated funded devnet wallet. No deployment or live data migration is included in this branch.

## Recovery

Order and top-up completion lock the pouch and retain their operation ID. Before broadcast, signed transaction bytes and the signature are committed to an immutable journal. Retries check that signature and rebroadcast only those same bytes while valid. A database/cache failure after chain confirmation does not authorize another transfer. A later retry records the original confirmed result. Pending/expired/failed operations never silently become a fresh payment; expired or failed transactions require operator review.

Read-only reconciliation repairs chain-backed balances, spending and exposed vault settings. An unavailable chain read returns a clear error instead of reporting stale funds as available. Creation and owner configuration transactions are not journaled payment operations; an uncertain create needs administrative chain reconciliation before retrying creation.

Do not delete the operation journal to force a retry. Check the recorded signature, receipt and chain state first. Back up the journal with the database. It contains signed transactions, so restrict database access. Memory/mock mode is for local demos only and does not promise process-crash durability. Startup rejects combining mock mode with a persistent database, because mock outcomes are process-local.

## Voice

The UI now supports authenticated ElevenLabs text and Talk sessions through a signed-session endpoint. This bridge remains disabled by default until the provider tool headers are configured and verified. Authenticated read-only text chat remains available as a fallback. Server voice tools require both `VOICE_WEBHOOK_SECRET` (or the existing `ELEVENLABS_TOOL_SECRET` during migration) and an expiring, wallet-scoped Bearer token from `POST /auth/voice-token`. That token is bound to the parent web session; logout invalidates it. Voice tokens cannot access normal web routes. The signed-session endpoint returns a short-lived voice token for the current session. The client passes it only in `secret__solpouch_voice_token`; every provider webhook must read that secret variable into its Authorization header. See `voice/session-config.example.json`. Never configure a shared user token or expose the server secret to the browser. Set `ELEVENLABS_SECURE_TOOLS_CONFIGURED=true` only after checking those headers on a staging agent. Sessions end before token expiry and on workspace unmount/logout.

## Checks and limits

Automated tests cover real Ed25519 wallet signatures, replay/expiry, ownership isolation, voice scope, CSRF origins, trusted proxies, shared limits, version conflicts, concurrent completion, database save failures and recovery from a serialized journal after a simulated restart. PostgreSQL adapter tests use mocked connections unless an isolated integration database is explicitly supplied. Real database migration/restart and funded devnet checks must be recorded separately before rollout.

### Local verification recorded for this branch

- Backend: 85 tests passed; 1 Timescale/PostgreSQL integration test skipped (no `TEST_DATABASE_URL`).
- Shared/backend/web TypeScript and optimized Next.js production build passed.
- Web security tests: 3 passed. Production metadata/header smoke tests: 7 passed.
- Chrome against isolated local mock services: unauthenticated dashboard made no private data calls; missing wallet displayed a useful error; an injected test wallet signed a real Ed25519 challenge; owned pouch creation/read and sign-out passed with no page errors.
- Chrome top-up recovery: saved request survived reload; dropping the HTTP response after a completed mock deposit and reloading recovered the same request with one credit.
- No live database migration, real process/Timescale restart, or funded devnet transaction was run. The restart test reconstructs a store and transport from serialized journal data.

### Follow-up: live voice and real database checks

The deployed `solpouch.tech` widget returned the current user's pouch balance in a read-only typed exchange. Talk connected and produced the agent greeting in its transcript. Microphone/speaker audio quality was not judged. The live profile/sign-in code is being developed separately by the user's collaborator and was not in any advertised GitHub branch at the time of inspection; do not replace that deployment with this branch before reconciling the source.

The public devnet RPC returned the complete official genesis hash, and the deployed program was executable. This exposed and fixed a truncated hash in the original hardening guard. A dedicated new test wallet's faucet request failed, and its balance remained zero. Funded transactions have not been run. `scripts/devnet-preflight.ts` reproduces the read-only checks and optionally requests test SOL; it never uses the application's owner key. No legacy live pouches were reassigned because the live database and account-to-wallet ownership evidence were unavailable.

The network identifier was cross-checked against [Solana's genesis configuration](https://github.com/solana-labs/solana/blob/master/sdk/src/genesis_config.rs). Secure provider-variable behavior follows [ElevenLabs dynamic variable documentation](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables).

The follow-up integration suite passed **10 tests against real isolated PostgreSQL 18**, including cross-connection locking, backend disconnects, write failures, and an actual database process restart with journal-based recovery. Blockchain RPC was simulated in these database tests. The test fixture deliberately excludes Timescale-only schema statements; the deployed Timescale migration and analytics still need staging verification. The isolated server was stopped after testing. Reproduce using the opt-in environment variables documented in `apps/backend/test/postgres.integration.test.ts`.

Follow-up verification also passed: 90 default backend tests, production build/typechecks, three web security tests and seven metadata/header smoke tests. The opt-in Chrome regression in `apps/web/test/auth-voice.browser.mjs` verifies wallet login/logout, top-up lost-response recovery, read-only chat fallback, and cancellation without a fallback send. Provider responses in that regression are mocked; it does not establish production signed-agent configuration.
