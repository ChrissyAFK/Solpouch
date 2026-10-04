# Stripe test funding and devnet checkout

This branch adds a separate Stripe test-payment flow. Transak remains the default
provider and its implementation is unchanged. No real card charges, mainnet
funding or retailer purchase is supported by this flow.

## Configuration

Configure the isolated deployment's ignored `.env`, never commit secrets:

```dotenv
FUNDING_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
FUNDING_USD_PER_CAD=0.73
STRIPE_DEMO_MINT=1
VAULT_MODE=chain
TEST_USDC_MINT=CiXLdY9HrDvBb7x3XfiqGjCHCrf31SmVDEQp3kJ6Z4Mf
SOLANA_RPC_URL=https://api.devnet.solana.com
OWNER_KEYPAIR_PATH=/absolute/path/to/devnet-owner.json
# Optional if the mint authority is different:
# STRIPE_MINT_KEYPAIR_PATH=/absolute/path/to/devnet-mint-authority.json
FUNDING_RETURN_ORIGIN=https://solpouch.tech
DEMO_RETAILER_PAYMENTS=1
```

Chain mode requires DATABASE_URL and the existing vault/agent configuration.
Stripe stores records in its own `stripe_funding_requests` table, using
FUNDING_DATABASE_URL when set, otherwise DATABASE_URL. With minting disabled,
Stripe can use FUNDING_DATABASE_URL alongside the in-memory mock application;
payment status becomes paid, not confirmed, and no wallet credit is claimed.

The linked wallet is snapshotted on the request. The mint authority needs devnet
SOL for transaction fees and associated-token-account rent. The actual RPC must
report the devnet genesis hash, and the mint must have six decimals and the
configured authority. Missing or live Stripe keys disable checkout, not unrelated
API startup. A Stripe test key cannot be replaced with a live key to launch this.

For a local preview, set FUNDING_RETURN_ORIGIN to its localhost origin and make
sure WEB_ORIGINS and the web backend URL point at the isolated test services.
Do not run this worktree against production with a file watcher.

## Checkout and verification

1. Sign in and link the stage wallet. For the existing owner-signed pouch top-up,
   this must be the configured demo owner's wallet; general multi-wallet top-up
   signing is separate work.
2. Open `/funding`. Enter CAD5–200; at rate0.73, CAD25 quotes18.250000 devnet
   test-USDC. Rate and rounded-down amount are stored before contacting Stripe.
3. Redirect to Stripe-hosted test Checkout. Use card4242 4242 4242 4242, a future
   expiry, any CVC and a valid test billing postal code. Apple Pay/Google Pay are
   controlled by Stripe's configuration and browser/device eligibility.
4. Webhooks and owner-authenticated polling share the same reconciliation path.
   Only a verified test session with matching amount, currency, request ID and
   paid status advances the request. A success URL never proves payment.
5. Paid and devnet delivery are separate states. The service journals signed
   mint bytes before sending. Repeated events, a lost RPC response or a database
   failure reuse that same signature. Ambiguous expiry never creates a second
   transfer. An unresolved request needs review, not a new payment request.
6. Once delivery is confirmed, the page shows its devnet Explorer transaction
   and a pouch-top-up link. It does not change a pouch balance automatically.

## Webhooks

Use the Stripe CLI with the test account:

```sh
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:8787/funding-webhooks/stripe
```

Put that listener's signing secret into the isolated API environment. A dashboard
endpoint has its own separate signing secret. Production endpoint configuration,
when deliberately deployed, is:
`https://api.solpouch.tech/funding-webhooks/stripe`.

The exact Stripe POST webhook path bypasses browser CORS and generic application
rate limits, retains the body-size limit, and authenticates Stripe's signature
against the untouched raw body. Other endpoints retain existing protections.
No local Cloudflare tunnel configuration was found on this machine, so actual
routing and webhook delivery have not been verified or changed.

## Retailer stage scenario

Run the read-only lookup check from the backend workspace:

```sh
pnpm exec tsx scripts/demo-order-check.ts "Get me a Big Mac meal from McDonald's on Uber Eats."
```

This uses the configured AI provider and searches the Uber Eats domain. It saves
no order and signs no transfer. Do not substitute a hard-coded menu price when
lookup is unavailable. Source URLs/prices are search estimates, not a guaranteed
merchant quote, availability, delivery fee or retailer order.

The explicit retailer-demo action is separately gated. Preparing it shows the
source CAD estimate and converted test-USDC amount for review; confirmation
sends only a devnet transfer to CHECKOUT_PAY_TO. It never contacts Uber Eats to
place an order. Ordinary reference carts remain non-payable and auto-pay never
applies to the demo quote. Live voice use additionally requires updating the
external agent's tool schema/prompt from this branch.

## Verification record

Local Stripe API/mint fixtures and isolated PostgreSQL verification are covered
by the Stripe test files. Browser fixtures exercise redirects, account isolation,
quote presentation and status recovery. These are not a completed Stripe Checkout
session or a public devnet transfer.

On this machine no project `.env`, Stripe credentials, AI credentials or local
tunnel configuration was found. The actual McDonald's lookup returned:

```json
{"provider":"none","parsed":{"pouchHint":"uber eats","items":[{"requested":"big mac meal from mcdonald's on uber eats","qty":1}]},"lookup":null,"readyForReview":false}
```

Actual Stripe Checkout, a funded devnet mint/top-up/payment and live voice dry-run
remain dependent on the test credentials and devnet signer configuration.

Final local checks: 411 backend tests passed, 5 skipped (three optional legacy
DB tests and two process-restart tests without restart configuration). The run
included the isolated PostgreSQL suites and the five-request pool concurrency
regression. Web type checks, production build and 22 relevant browser fixtures
passed. Independent review retested the Stripe/demo fixes. Unpaid expired Stripe
sessions now release their checkout URL and allow starting a new request; recorded
paid states never regress to expired.
