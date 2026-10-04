# Product

<!-- impeccable:product-schema 1 -->

_Written 2026-10-04 during an unattended redesign loop. Facts come from the repo
(landing copy, README, STATUS.md) and the owner's knowledge base; no interview
round was run. Items marked (inferred) were not confirmed by the owner._

## Platform

web (also shipped to Android as a Trusted Web Activity of the same site)

## Users

- Students on a budget who want spending money split into hard-capped buckets
  (Uber Eats, groceries, fun money) and want to order by voice.
- Trades, construction and small-business people (often older) who bulk-order
  job materials and would rather say the order than use supplier websites.

## Product Purpose

Solpouch splits money into pouches. Each pouch is its own Solana vault holding
USDC with its own rules (per-order limit, daily limit, allowed stores, freeze).
An assistant (voice via ElevenLabs, or typed chat) finds items and builds a cart;
every line is checked against the pouch rules; the owner approves the exact
order, then the pouch pays. Success: spending stays inside limits the owner set,
with no way for the assistant to exceed them.

## Positioning

The limits are enforced on-chain by the team's own program, not by a promise in
an app. The assistant can ask and build a cart; it cannot pay on its own and it
cannot refill a pouch. Refills are owner-only and wait out a friction period.

## Operating Context

Phone-first ordering by voice, desktop dashboard for setting up pouches, reviewing
orders and receipts. Funding via Stripe (test mode for the demo) minting devnet
test-USDC; real-money on-ramp (Transak) pending KYB. Google sign-in is the account;
a linked Solana wallet is only for money.

## Capabilities and Constraints

- Routes: landing, dashboard (overview), pouches, pouch detail, funding,
  shopping lists, orders, new order, profile (preferences: theme, motion, text
  size), about, privacy, terms, contact, delete-account.
- Ask Solpouch chat widget with Talk (voice) button.
- Next.js app with a strict CSP nonce; fonts come from `next/font/google`.
- Light and dark palettes both exist; the landing is forced dark.
- Don't change copy or functionality during the redesign.

## Brand Commitments

- Name "solpouch" (lowercase wordmark), domain solpouch.tech.
- Solana purple and green appear in the current mark (inferred: worth keeping as
  a nod, not binding).
- Voice: plain, short, honest sentences; no hype, no crypto jargon beyond
  "USDC on Solana".

## Evidence on Hand

- Example pouches on the landing (Uber Eats, Groceries, Deck rebuild) are
  illustrative and labelled as an example.
- No customers, testimonials, volumes or press exist. Do not invent any.

## Product Principles

1. Limits are the product: every surface should make the boundary visible.
2. The human approves; the assistant only proposes.
3. Plain language over crypto language.
4. Trust through specifics (exact amounts, exact rules), not adjectives.

## Accessibility & Inclusion

Older users in the trades audience: generous text sizes (a text-size preference
exists), strong contrast, large touch targets, reduced-motion preference honored.
