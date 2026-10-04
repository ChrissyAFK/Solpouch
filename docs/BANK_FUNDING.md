# US and Canadian wallet funding

This branch starts the bank integration; it does **not** enable real-money banking.
The previously completed fixes were pushed to `codex/review-fixes` at `e1851b6`
before this work began. The funding branch combines those fixes with the wallet,
voice and Claude work from `origin/scaffold` at `ef69555`.

## What is implemented

- Signed-in Google accounts link a Solana wallet using a one-use signed challenge.
  The backend obtains the funding destination from the verified account record.
- `/funding` offers United States/USD and Canada/CAD, with separate Add money
  and Cash out requests. BUY input is fiat; SELL input is USDC.
- Transak creates a signed, single-use **staging** checkout URL on the backend.
  The hosted screen presents its current quote, fees, eligible payment methods
  and identity checks before the user commits. The app does not invent a rate,
  collect bank credentials or promise availability in every state/province.
- Requests are stored in PostgreSQL before an external session request. An
  account-scoped idempotency key prevents network retries from opening duplicate
  sessions. Provider notifications require JWT signature verification and must
  match the stored country, currency, direction and amount. BUY also matches the
  verified destination wallet; SELL uses the provider's deposit flow and does not
  treat its deposit address as the user's wallet.
- Requests track processing, failure, cancellation, refund and sandbox completion.
  Provider order reconciliation can recover notifications missed by the server.
  Returning from checkout, an AI response or a browser event never credits funds.
- Funding and cash-out histories are account scoped. They do not modify pouch
  balances. Sandbox completion explicitly means **no real money moved**.

## Local and staging setup

1. Create a Transak partner account. Obtain staging credentials and register the
   web domain. Never place the partner access token in a `NEXT_PUBLIC_` variable.
2. Configure the server-only `TRANSAK_API_KEY`, `TRANSAK_ACCESS_TOKEN`,
   `TRANSAK_REFERRER_DOMAIN`, and leave `TRANSAK_ENV=staging`.
3. Supply durable PostgreSQL storage. With the existing chain setup,
   `DATABASE_URL` is reused. To run the mock app without Solana signer keys, set
   `FUNDING_DATABASE_URL` separately and leave `DATABASE_URL` empty. This second
   database only stores funding requests; mock pouch balances remain in memory.
   In this memory setup, a restart loses sessions and linked-wallet/profile
   records. Sign in and relink the wallet before starting another request;
   previously stored PostgreSQL funding history remains available after sign-in.
   Production auth needs the persistent account/session store.
4. Register the HTTPS backend webhook `/funding-webhooks/transak` with Transak.
   Its JSON body has a signed JWT in `data`. Check the exact path against `app.ts`
   when configuring an ingress prefix. Keep provider tokens out of logs.
5. Confirm current Solana USDC and payment-method eligibility with the provider
   for each region and direction. Only then populate
   `TRANSAK_ENABLED_CAPABILITIES`, for example `US:BUY,CA:BUY`. SELL needs its own
   provider approval/configuration. Empty capabilities disable every route.
6. Sign in, link a wallet, open `/funding`, create a staging checkout, then use
   Check status. Verify both webhooks and reconciliation with actual provider
   payloads before marking the staging integration operational.

No provider account or credentials were available during implementation. Local
fixtures do not establish current regional coverage, provider account approval,
actual checkout success or bank settlement. Partner access tokens expire; rotate
server configuration as required by the provider. Verify event delivery during
rotation before relying on notifications alone.

## Mainnet and pouch transfer boundary

Real-money Transak sessions are blocked even if `TRANSAK_ENV=production` is set.
The existing server-signed vault adapter also remains devnet-only.

`vault/ownerTransactions.ts` prepares **unsigned devnet** deposit and withdrawal
transactions with on-chain owner, program, mint, PDA, token-balance and SOL fee/
rent checks. Withdrawals target the owner's own associated token account. It
never signs or broadcasts and is deliberately not mounted as an API route yet.
The mainnet USDC mint is pinned to Circle's official Solana address. A separate
read-only verifier checks finalized mainnet USDC receipts, but it is not connected
to a balance-crediting path while funding is staging-only.

Before real funds:

- Verify staging BUY and SELL in both regions, including declined/cancelled
  payments, amount changes, delayed notifications, refunds and token rotation.
- Review and deploy the vault program for mainnet; verify its program ID and
  upgrade authority. Replace demo server owner signing with the linked user's
  wallet approval and verify submission/confirmation/recovery end to end.
- Persist an immutable transaction intent before wallet submission; recover the
  same signed transaction after uncertainty, verify finality and reconcile the
  actual vault balance. Never create a second transfer just because an RPC timed
  out. Account for SOL fees and account-creation rent in the signing screen.
- Use the official mainnet USDC mint, verify RPC genesis, recipient and amount,
  and bind each real receipt uniquely to its funding request before crediting.
- Implement the reviewed pouch-to-wallet withdrawal flow before presenting
  pouch balances as cash-out funds. Provider SELL currently concerns wallet funds.
- Obtain production provider access and regional capabilities. Make a small live
  transfer only after the user explicitly authorizes it. No real transfer was
  authorized or performed by this implementation.

Instacart remains a shopping-list checkout handoff; funding a wallet or pouch does
not make Instacart charge USDC automatically.

## Provider references

- [Signed widget sessions](https://docs.transak.com/api/public/create-widget-url)
- [Widget parameters](https://docs.transak.com/customization/query-parameters)
- [Signed webhook verification](https://docs.transak.com/guides/how-to-decrypt-webhook-payload)
- [Payment-method and country lookup](https://docs.transak.com/api/public/get-fiat-currencies)
- [Sandbox testing](https://docs.transak.com/guides/sandbox-credentials)
- [US payment terms](https://transak.com/terms-of-service-us)
- [Transak Canada and Interac](https://transak.com/blog/transak-canada-achieves-fintrac-registration-strengthening-commitment-to-secure-and-compliant-crypto-access)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)

## Verification recorded for this change

- Workspace TypeScript checks and the Next production build passed.
- Backend: 194 passed, including 19 real local PostgreSQL checks. Both existing
  payment recovery and new funding records were exercised across actual database
  process restarts. One existing Timescale-specific test remains skipped.
- Browser: 34 regression checks passed with intercepted backend/provider fixtures,
  including seven funding checks. Those seven also passed against the production
  build. Account-switch responses, lost-response retry UUIDs, terminal request
  reset, untrusted URLs and missing storage/configuration are covered.
- Three web security tests and eight production HTTP/metadata/CSP checks passed.
- Mobile layout and setup-required screenshots were inspected at 390px width.
- No real Transak checkout, bank settlement, funded devnet or mainnet transfer was
  tested. The mainnet receipt verifier and unsigned owner-transfer preparer use
  RPC fixtures in their unit tests; they are not live-money readiness evidence.
