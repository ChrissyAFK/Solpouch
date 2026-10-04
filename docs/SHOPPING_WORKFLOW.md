# Shopping workflow

## Added

- `/lists`: create, rename, edit, delete and reuse account-owned shopping lists.
  Reusing a list creates a new draft and resolves products/prices again. It does
  not duplicate an old paid order or submit a payment.
- Draft cart editor: change quantities, remove lines, or choose a replacement
  from the same catalog. Web/retailer reference carts support quantities and
  removal; a new search is needed for different products. At least one item must
  remain. Prices and totals are recalculated on the backend.
- Edits require the current order version. Checkout links are hidden while edits
  are unsaved; editing an Instacart list invalidates its old link. Reference carts
  stay reference-only and cannot become internally payable by editing.
- HTTP and voice draft confirmations must carry the reviewed `version`. Stale
  or missing approval versions are rejected. Retrying an already-started payment
  continues its existing recovery behavior.
- Overview: 7/30-day recorded spending and the previous period, per-pouch totals,
  current balance and remaining daily allowance. Unpaid carts and retailer
  estimates are excluded. Date windows use UTC payment timestamps; allowance
  uses the pouch's current counter. Frozen pouches have zero available spend.
  Simulated payments are labeled; these figures are not bank-settlement reports.
- First-use overview: explains limits and approval, creates a pouch using the
  existing form, then links to saved lists and cart review.

## Storage and integration limits

Lists use the configured Store. PostgreSQL persists them across restarts. In the
existing memory-only mock mode, lists are temporary, just like pouches and user
profiles; restarting the server clears them. A UI save alone is not durable
storage in that mode.

Instacart checkout still requires configured provider credentials. Checkout
links do not place orders or pay from a pouch. The live voice agent must adopt the
`confirm_order.version` schema in `voice/tools.json`; this change does not edit
that external agent. Banking configuration was not changed.

## Verification

Backend tests cover ownership, stale versions, quantity validation, catalog price
resolution, reference preservation and checkout-link invalidation. Browser tests
use local API fixtures, including HTTP 204 deletion, list reuse, cart approval
versions, unsaved changes and first-pouch setup. Live retailer transactions are
not part of these checks.

The backend suite passed 201 checks with one existing Timescale-specific test
skipped, including 20 real PostgreSQL checks. The expanded shopping tests then
passed nine checks (including three added after that full run), and workspace
typechecks passed. The browser suite covered the existing flows plus shopping
and overview changes using fixtures; production build and security/metadata
checks also passed. These checks do not verify live Instacart or voice setup.
