# Audit fixes and verification

This change follows the 16-findings audit of local commit `4e6bb19`. It preserves Google sign-in and the current voice contract while integrating recovery/storage controls from the separate backend-hardening work. It does not deploy or configure external provider accounts.

## Finding coverage

| Audit | Implemented correction | Regression evidence |
|---|---|---|
|1 Duplicate top-ups | Pouch locks, processing state, signed operation journal, atomic mock transfers; unique memo distinguishes separate chain top-ups | recovery, PostgreSQL integration |
|2 Payment reset after save failure | Keep paying, recover the same signature/bytes, never automatically replace uncertain transactions | recovery, real PostgreSQL injected failure/restart |
|3 Startup refills | Startup only reads existing chain state; no automatic funding | recovery |
|4 Stale account pages | Private page subtree keyed by session; account-scoped async work | workspace browser |
|5 Unrevoked logout | Persisted Google sessions, logout/all/list/revoke, voice parent-session checks | session revocation, auth, workspace browser |
|6 Spoofable limits | Explicit trusted proxy peers/header; persistent Store counters | security, PostgreSQL integration |
|7 Database TLS | Verify certificates by default; explicit local plaintext test URL only | storage hardening |
|8 Lost checkout metadata | Additive JSONB persistence and round trip for retailer/link metadata | PostgreSQL integration |
|9 Late profile response | Expected-session checks before profile state/storage updates | workspace browser |
|10 Out-of-order refresh | Request generations plus session checks across page loads | workspace browser |
|11 Draft date used for payment | New paidAt/completedAt; undated legacy payments omitted from date buckets but retained in history | backend flow, workspace browser |
|12 Unsafe quantities/totals | Bounded integer quantities/item count, exact safe totals before saving/paying | order validation |
|13 Voice AI budget gap | Shared per-account minute/day budget around expensive service calls | auth/security |
|14 Voice binding mismatch | Required user-token binding in tools/docs, compatible body binding plus documented header option | auth and contract inspection |
|15 Login outage misclassified | Separate invalid credentials from provider/storage/signing outages | session revocation/auth |
|16 Dead navigation hashes | Absolute landing-page section URLs | workspace browser |

## Features

- Payment/top-up pending states, transaction links where a journal signature is available, and checks that recover the original operation.
- Account-backed chat cart cards with item/substitution details, retailer links and explicit catalog payment approval. Text-model output does not authorize actions.
- Order history search, pouch/store/status/date filters, safe CSV download, and text receipts. Undated historical payments are labeled accurately.
- Opt-in browser-local alerts for ready top-ups and 80% daily spend, scoped/deduplicated by account. No unsolicited email or push messages.
- Session listing, per-session revocation, sign-out everywhere, immediate local sign-out and visible failure if server revocation fails. Voice expiry closes the connection without replay.
- Instacart shopping-list link integration selected by the user. See `INSTACART.md`. Links are cached/persisted; missing keys/provider failures are explicit. This feature does not verify or charge a retailer purchase.

## Verification commands

```sh
pnpm --filter @solpouch/backend test
pnpm -r typecheck
pnpm --filter @solpouch/web build
pnpm --filter @solpouch/web test:security
WEB_TEST_URL=http://localhost:3003 pnpm --filter @solpouch/web test:browser
WEB_TEST_URL=http://localhost:3003 pnpm --filter @solpouch/web test:smoke
```

Browser tests require Playwright/Chrome; `PLAYWRIGHT_MODULE` can identify an existing Playwright installation. They intercept backend/provider traffic and never move real funds.

The isolated PostgreSQL suite accepts `POSTGRES_INTEGRATION_URL` pointing at a local disposable server. Optional `POSTGRES_INTEGRATION_PG_CTL` and `POSTGRES_INTEGRATION_DATA_DIR` enable the actual restart test, which validates the target before stopping it. It uses fresh schemas and the production relational store, excluding Timescale-only analytics DDL. Never point this suite at a production database.

## Deployment requirements and limits

- Existing stateless JWTs are intentionally invalidated; users sign in again after deployment. Keep a stable backend `SESSION_SECRET` of at least 32 bytes and persisted storage for sessions.
- Apply the additive schema changes and provide a valid database CA when needed. Configure trusted proxy peers for the actual ingress; untrusted forwarding headers are ignored.
- The backend chain signer remains devnet-only; wallet-owned production funding is a separate product integration. This change is not mainnet payment approval.
- Instacart activation requires a development/production API key configured on the backend. Local provider fixtures do not prove live account access, checkout availability, purchases or delivery.
- Live Google/ElevenLabs configuration and funded devnet transfers are not exercised by the local suites. Re-check the provider token binding and origin restrictions before deployment.
- Expired/failed blockchain operations remain held for review. The application will not automatically send a replacement payment.

## Final local verification

149 backend tests passed, including 13 real PostgreSQL integration tests and an actual database restart. The older opt-in Timescale test was skipped. 27 production-browser tests, 3 security tests, 7 smoke tests, all workspace typechecks and the production build passed. Browser/provider traffic and blockchain transport were fixtures; no funded chain transfer or live Instacart call was made.

During final verification, Git fetched `4898843` on `scaffold` and `combine/auth-wallet`, combining linked-wallet authentication with hardening. That concurrent work is not merged into this review-fixes branch. Reconcile the identity/storage/provider contracts before deploying the two branches together; do not overwrite either implementation blindly.
