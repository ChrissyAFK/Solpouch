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
}

export interface Pouch {
  id: string;
  /** On-chain Pouch PDA address. */
  address: string;
  name: string;
  balance: Micros;
  maxPerOrder: Micros;
  dailyLimit: Micros;
  spentToday: Micros;
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
}

export type TopUpStatus = "started" | "cooling_down" | "completed" | "cancelled";

export interface TopUp {
  id: string;
  pouchId: string;
  amount: Micros;
  reason: string;
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
  "OrderAlreadyUsed",
] as const;
export type VaultError = (typeof VAULT_ERRORS)[number];
