// The API contract between backend, web dashboard and voice agent.
// Money is always in micro-USDC (6 decimals): 1 USDC = 1_000_000.

export type Micros = number;
export const MICROS_PER_USDC = 1_000_000;
export const toUsdc = (m: Micros) => m / MICROS_PER_USDC;
export const toMicros = (usdc: number) => Math.round(usdc * MICROS_PER_USDC);

export interface Merchant {
  id: string;
  name: string;
  /** Solana wallet the merchant is paid to. Must be on a pouch's allowlist. */
  payTo: string;
  kind: "grocery" | "food" | "building_supply" | "other";
  /** "catalog" = built-in store, "web" = found online. */
  source?: "catalog" | "web";
  url?: string;
}

/** Prefix for owner-added web stores in Pouch.allowedMerchantIds, e.g. "web:homedepot.ca". */
export const WEB_PREFIX = "web:";
/** An empty allowedMerchantIds list means the pouch may pay any store. */
export const isAnyStore = (p: Pick<Pouch, "allowedMerchantIds">) => p.allowedMerchantIds.length === 0;
/** The vault program stores at most this many merchant wallets per pouch (MAX_MERCHANTS in programs/solpouch_vault). */
export const MAX_ALLOWED_MERCHANTS = 10;

/** Rule errors the backend reports with a 422. These mirror check_rules in the vault program. */
export type PouchRuleError = "TooManyMerchants" | "ZeroLimit" | "PerOrderOverDaily" | "DuplicateMerchant";

/**
 * Checks pouch limits the same way, and in the same order, as the vault program's check_rules.
 * Returns the program's error code, or undefined when the rules are valid.
 */
export function pouchRuleError(r: { maxPerOrder: number; dailyLimit: number; allowedMerchantIds: string[] }): PouchRuleError | undefined {
  if (r.allowedMerchantIds.length > MAX_ALLOWED_MERCHANTS) return "TooManyMerchants";
  if (r.maxPerOrder <= 0 || r.dailyLimit <= 0) return "ZeroLimit";
  if (r.maxPerOrder > r.dailyLimit) return "PerOrderOverDaily";
  if (new Set(r.allowedMerchantIds).size !== r.allowedMerchantIds.length) return "DuplicateMerchant";
  return undefined;
}

export interface Pouch {
  version?: number;
  id: string;
  /** On-chain Pouch PDA address. */
  address: string;
  name: string;
  balance: Micros;
  maxPerOrder: Micros;
  dailyLimit: Micros;
  spentToday: Micros;
  spentSince?: string;
  /** Orders at or below this amount skip confirmation. 0 = always confirm. */
  confirmAbove: Micros;
  allowedMerchantIds: string[];
  frozen: boolean;
}

export interface Product {
  id: string;
  merchantId: string;
  name: string;
  brand?: string;
  size?: string;
  unitPrice: Micros;
  inStock: boolean;
  url?: string;
  /** True when the price came from a web search, not a catalog. */
  estimated?: boolean;
}

export interface OrderLine {
  /** What the user asked for, as Gemini understood it. */
  requested: string;
  requestedQty: number;
  product: Product | null;
  qty: number;
  lineTotal: Micros;
  /** 0..1, Gemini's score of how well the product matches the request. */
  matchScore: number;
  substitution: boolean;
  /** Plain-English note, e.g. "Oat milk was out, picked Silk instead". */
  note?: string;
}

export type OrderStatus =
  | "draft" // cart built, waiting for the user
  | "confirmed" // user approved the exact cart
  | "paying"
  | "paid"
  | "rejected" // vault program or policy refused
  | "cancelled";

export interface Order {
  version?: number;
  paidAt?: string;
  id: string; // also the on-chain order_id (16 bytes, hex)
  pouchId: string;
  merchantId: string;
  request: string;
  lines: OrderLine[];
  total: Micros;
  status: OrderStatus;
  /** Set when rejected, e.g. "OverDailyLimit". */
  rejectReason?: string;
  txSignature?: string;
  createdAt: string;
  store?: { name: string; domain: string; url?: string };
  fulfillment?: { via: "direct" | "instacart" | "service"; label: string; checkoutUrl?: string; linkStatus?: "ready" | "unavailable" | "not_configured"; linkCreatedAt?: string; linkExpiresAt?: string };
}

/** Web search results are references, never retailer-authorized payment quotes.
 * Inspect legacy fields too: old drafts have no explicit quote provenance. */
export function isCheckoutReference(order: Order): boolean {
  return order.merchantId.startsWith(WEB_PREFIX) || !!order.store ||
    !!(order.fulfillment && order.fulfillment.via !== "direct") ||
    order.lines.some((line) => line.product?.estimated === true);
}

/** Creating a checkout link does not convert the original quote currency. */
export function orderCurrency(order: Order): "CAD" | "USDC" {
  return order.merchantId.startsWith(WEB_PREFIX) || !!order.store || order.lines.some(l=>l.product?.estimated) ? "CAD" : "USDC";
}

export type TopUpStatus = "started" | "cooling_down" | "processing" | "completed" | "cancelled" | "failed";

export interface TopUp {
  version?: number;
  /** Set when status is "failed": the vault rejection code. */
  failReason?: string;
  txSignature?: string;
  completedAt?: string;
  id: string;
  pouchId: string;
  amount: Micros;
  reason: string;
  /** The account's linked wallet (base58) when the top-up was requested. */
  fromWallet?: string;
  status: TopUpStatus;
  /** When the cooldown ends and the top-up can be completed. */
  readyAt: string;
  createdAt: string;
}

export interface SpendPoint {
  bucket: string; // ISO timestamp of the day/hour bucket
  pouchId: string;
  spent: Micros;
  orders: number;
}

export type WithdrawalStatus = "holding" | "processing" | "completed" | "cancelled" | "failed";

/**
 * Money leaving a pouch for the owner's linked wallet. It is held for a fraud
 * review window (7 days by default) during which the owner can cancel it; the
 * held amount can't be spent by orders.
 */
export interface Withdrawal {
  version?: number;
  id: string;
  pouchId: string;
  amount: Micros;
  reason: string;
  /** The linked wallet the money goes to, fixed when requested. */
  toWallet: string;
  status: WithdrawalStatus;
  /** When the hold ends and the withdrawal is paid out. */
  readyAt: string;
  createdAt: string;
  txSignature?: string;
  /** Set when status is "failed". */
  failReason?: string;
}

export interface StartWithdrawalBody {
  pouchId: string;
  amount: Micros;
  reason?: string;
}

// ---- REST API ----
// GET    /pouches                     -> Pouch[]
// POST   /pouches                     CreatePouchBody -> Pouch
// GET    /pouches/:id                 -> Pouch
// PATCH  /pouches/:id/rules           UpdateRulesBody -> Pouch
// POST   /pouches/:id/freeze          -> Pouch
// POST   /pouches/:id/unfreeze        -> Pouch
// POST   /orders                      CreateOrderBody -> Order (status "draft")
// GET    /orders?pouchId=             -> Order[]
// GET    /orders/:id                  -> Order
// POST   /orders/:id/confirm          -> Order (pays; ends "paid" or "rejected")
// POST   /orders/:id/cancel           -> Order
// POST   /topups                      StartTopUpBody -> TopUp (status "cooling_down")
// POST   /withdrawals                 StartWithdrawalBody -> Withdrawal (status "holding", readyAt = now + hold)
// GET    /withdrawals?pouchId=        -> Withdrawal[] (holding/processing, plus completed/failed from the last 7 days)
// POST   /withdrawals/:id/cancel      -> Withdrawal (holding -> cancelled)
// Due withdrawals are paid out by the backend; there is no client "complete" call.
// GET    /topups?pouchId=             -> TopUp[] (pending/cooling_down, newest first)
// POST   /topups/:id/complete         -> TopUp (only after readyAt)
// POST   /topups/:id/cancel           -> TopUp (cooling_down -> cancelled)
// GET    /merchants                   -> Merchant[]
// GET    /merchants/:id/products      -> Product[]
// GET    /stats/spend?pouchId=&bucket=day|hour -> SpendPoint[]
// POST   /voice/tools/:tool           ElevenLabs server-tool webhook (see voice/)

export interface CreatePouchBody {
  name: string;
  maxPerOrder: Micros;
  dailyLimit: Micros;
  confirmAbove?: Micros;
  allowedMerchantIds: string[];
}

export type UpdateRulesBody = Partial<Omit<CreatePouchBody, "name">>;

export interface CreateOrderBody {
  /** Free text, e.g. "200 8-foot 2x4s and ten boxes of 3-inch deck screws". */
  request: string;
  /** Optional: if omitted, Gemini picks the pouch. */
  pouchId?: string;
}

export interface StartTopUpBody {
  pouchId: string;
  amount: Micros;
  /** Optional; defaults to "Top-up". */
  reason?: string;
}

export interface ApiError {
  error: string;
  /** Vault program error name when the chain refused, e.g. "OverDailyLimit". */
  code?: string;
}

/** Error names emitted by the solpouch_vault program. Keep in sync with programs/solpouch_vault. */
export const VAULT_ERRORS = [
  "Unauthorized",
  "PouchFrozen",
  "MerchantNotAllowed",
  "OverPerOrderLimit",
  "OverDailyLimit",
  "InsufficientFunds",
  "NameTooLong",
  "TooManyMerchants",
  "VaultNotEmpty",
  "ZeroAmount",
  "AgentIsMerchant",
  "ZeroLimit",
  "PerOrderOverDaily",
  "AgentIsOwner",
  "DuplicateMerchant",
  "MerchantTokenNotAta",
  "OrderAlreadyUsed",
  "PouchNotOnChain",
  "AgentKeyMismatch",
  "SignerOutOfSol",
  "ChainRejected",
  "TxFailed",
  "TxExpired",
] as const;
export type VaultError = (typeof VAULT_ERRORS)[number];

/** Reusable requests, without a stored price or payment authorization. */
export interface ShoppingListItem { name: string; qty: number }
export interface ShoppingList { id: string; version?: number; name: string; items: ShoppingListItem[]; createdAt: string; updatedAt: string }
export interface EditOrderBody { version: number; lines: { index: number; qty: number; productId?: string }[] }
