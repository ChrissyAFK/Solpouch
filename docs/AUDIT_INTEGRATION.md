# Audit branch integration

Local branch: `codex/integrate-audit`. Integrates `fix/audit-2` at `132daaa`
(including `fix/audit`) into shopping workflow commit `835fdde`.
No push, deployment, production migration or public-chain transaction was made.

## Review decisions

- Preserve account ownership, revocable sessions, signed voice sessions, saved
  lists and exact cart-version approval from the existing branch. Incoming
  `confirmAbove` behavior does not waive approval or add an auto-pay control.
- An expired transaction whose RPC history is missing is still uncertain. Keep
  its payment journal recoverable; only a confirmed or finalized failure permits terminal failure. A processed-only RPC error remains pending.
- Use payment timestamps and transaction identity for payment-history indexing.
  An indexed subset must not hide other recorded paid orders in spending totals.
- Refresh voice-created orders without overwriting unsaved cart edits. A failed
  balance refresh must not change a successful payment into a displayed failure.
- Keep voice session timeouts, account switching and no-replay behavior together.
  Top-up recovery uses server status, including terminal failures.
- Update the close-pouch IDL for its required owner token account and new errors.
  Both committed IDL copies match the IDL generated from the compiled program.

## Verification

- Web: production build and typecheck passed; 45 distinct browser fixture tests,
  three security tests, eight HTTP smoke tests and the audio-worklet CSP harness
  passed. The smoke preview was restarted after the final build.
- Vault: Anchor build, ten Rust unit tests and sixteen integration tests against
  an isolated local validator passed. Tests cover payment limits, frozen pouches,
  duplicate payment IDs, zero amounts, unsafe merchant-rule changes, close-pouch
  ownership and returning unsolicited dust to the owner.
- The vault integration harness refuses non-local RPC endpoints. No public
  devnet or mainnet transactions are part of these checks.

- Backend: 228 unit/API checks and 23 real PostgreSQL checks passed, including
  process restart, concurrent profile updates, payment-metric deduplication and
  failed-top-up persistence. One legacy Timescale-specific test remains skipped.
- Backend, shared and web typechecks passed after test-fixture corrections.
- Independent review found and rechecked processed-only RPC error handling,
  expired spending counters in list responses and new vault error mapping.
  Its 27 recovery/error tests passed with no outstanding confirmed findings.

Payment metric writes are active after paid orders. The event-indexer helpers
are preserved and tested but are not wired into startup; complete chain-history
backfill is still future work. Spending totals use owned orders and `paidAt`,
so a partial metrics table cannot omit a paid order.

## Still outside this verification

The revised vault program has not been redeployed. Production TimescaleDB schema
compatibility, funded public devnet behavior and live provider callbacks still
need their own environment checks. Browser tests use API/WebSocket fixtures.
Live ElevenLabs, Instacart and Transak setup is not established by these tests.
Bank funding remains gated staging work; mainnet deposits and withdrawals are
not enabled. The live site is unchanged by this local integration.
