import type { Order, Pouch, SpendPoint, TopUp } from "@solpouch/shared";

/** A pouch as stored: carries its owner. Never send ownerEmail over the API, use publicPouch(). */
export type StoredPouch = Pouch & { ownerEmail?: string; /** ISO start of the rolling 24h spend window (the vault's day_start). */ spentSince?: string };

const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Spend counted inside the chain's rolling 24h window: lapsed windows read as zero. */
export function windowedSpend(spentToday: number, spentSince: string | undefined, now = Date.now()): number {
  if (!spentSince) return spentToday;
  return now - Date.parse(spentSince) < SPEND_WINDOW_MS ? spentToday : 0;
}
/** The window start to persist: the known one, else now when there is spend, else none. */
export function spendWindowStart(p: { spentToday: number; spentSince?: string }, now = Date.now()): string | undefined {
  return p.spentSince ?? (p.spentToday > 0 ? new Date(now).toISOString() : undefined);
}
export function publicPouch(p: StoredPouch): Pouch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ownerEmail: _o, ...rest } = p;
  return rest;
}

export type UserProfile = { email: string; displayName?: string; avatar?: string; wallet?: string; createdAt: string; updatedAt: string };

export type UserPatch = { displayName?: string | null; avatar?: string | null; wallet?: string | null };

export class StoreConflictError extends Error {
  constructor(message = "Record changed; reload it before retrying") {
    super(message);
    this.name = "StoreConflictError";
  }
}
export interface VaultOperation {
  id: string;
  kind: "pay" | "topup";
  pouchId: string;
  txSignature: string;
  signedTransaction: string;
  lastValidBlockHeight: number;
  createdAt: string;
}
/** A pending "link this wallet to the signed-in account" proof request. */
export interface AuthChallenge { id: string; wallet: string; email: string; message: string; expiresAt: string }

/** Persistence boundary. All reads and saves return detached values. Use the version returned by a save. */
export interface Store {
  /** With ownerEmail, only that user's pouches. Without, all (internal use only). */
  listPouches(ownerEmail?: string): Promise<StoredPouch[]>;
  getPouch(id: string): Promise<StoredPouch | undefined>;
  savePouch(p: StoredPouch): Promise<StoredPouch>;
  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;
  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
  /** Newest first. */
  listTopUps(pouchId: string): Promise<TopUp[]>;

  getUser(email: string): Promise<UserProfile | undefined>;
  saveUser(u: UserProfile): Promise<UserProfile>;
  /** Atomically update only the given fields (undefined = keep, null = clear). Creates the user if missing. */
  updateUser(email: string, patch: UserPatch, now: string): Promise<UserProfile>;
  findUserByWallet(wallet: string): Promise<UserProfile | undefined>;

  withPouchLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  getOperation(id: string): Promise<VaultOperation | undefined>;
  saveOperation(record: VaultOperation): Promise<void>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  consumeChallenge(id: string): Promise<AuthChallenge | undefined>;
  consumeRateLimit(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfter: number }>;

  /** Time-series (Tiger Data). Idempotent per txSignature. */
  recordPayment(p: PaymentRecord): Promise<void>;
  /** Price history rows, idempotent per (merchantId, productId, time). */
  recordPrices(rows: PriceRecord[]): Promise<void>;
  /** Spend per pouch per bucket since `since` (ISO), sorted by bucket. Callers must pass only pouch ids they may see. */
  spendSeries(pouchIds: string[], bucket: "hour" | "day", since: string): Promise<SpendPoint[]>;
}

export interface PaymentRecord { time: string; pouchId: string; merchantId: string; orderId: string; amount: number; txSignature: string }
export interface PriceRecord { time: string; merchantId: string; productId: string; unitPrice: number; inStock: boolean }

export function sameOperation(a: VaultOperation, b: VaultOperation): boolean {
  return a.id === b.id && a.kind === b.kind && a.pouchId === b.pouchId && a.txSignature === b.txSignature && a.signedTransaction === b.signedTransaction && a.lastValidBlockHeight === b.lastValidBlockHeight && a.createdAt === b.createdAt;
}

export function validateRateLimit(key: string, windowMs: number, max: number): void {
  if (!key || key.length > 512 || !Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(max) || max <= 0) throw new Error("Invalid rate limit configuration");
}
