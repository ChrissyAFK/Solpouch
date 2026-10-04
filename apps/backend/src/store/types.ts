import type { Order, Pouch, SpendPoint, TopUp, ShoppingList } from "@solpouch/shared";

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
export interface AuthSession { id: string; email: string; name: string; picture: string; createdAt: string; expiresAt: string }

/** All reads and saves return detached values. Use the version returned by a save. */
export interface AuthChallenge { id: string; wallet: string; email: string; message: string; expiresAt: string }
export type StoredShoppingList = ShoppingList & { ownerEmail: string };
export interface Store {
  updateUser(email: string, patch: UserPatch, now: string): Promise<UserProfile>;
  recordPayment(p: PaymentRecord): Promise<void>;
  recordPrices(rows: PriceRecord[]): Promise<void>;
  spendSeries(pouchIds: string[], bucket: "hour" | "day", since: string): Promise<SpendPoint[]>;
  readonly persistentLists?: boolean;
  listShoppingLists(ownerEmail: string): Promise<StoredShoppingList[]>;
  getShoppingList(id: string): Promise<StoredShoppingList | undefined>;
  saveShoppingList(list: StoredShoppingList): Promise<StoredShoppingList>;
  deleteShoppingList(id: string, ownerEmail: string, version: number): Promise<void>;
  findUserByWallet(wallet: string): Promise<UserProfile | undefined>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  consumeChallenge(id: string): Promise<AuthChallenge | undefined>;
  listPouches(ownerEmail?: string): Promise<StoredPouch[]>;
  getPouch(id: string): Promise<StoredPouch | undefined>;
  savePouch(p: StoredPouch): Promise<StoredPouch>;
  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;
  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
  withPouchLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  applyMockOperation(pouch: StoredPouch, operation: VaultOperation): Promise<void>;
  getOperation(id: string): Promise<VaultOperation | undefined>;
  saveOperation(record: VaultOperation): Promise<void>;
  saveSession(session: AuthSession): Promise<void>;
  getSession(tokenHash: string): Promise<AuthSession | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  listSessions(email: string): Promise<AuthSession[]>;
  deleteSessions(email: string): Promise<void>;
  listTopUps(pouchId: string): Promise<TopUp[]>;
  getUser(email: string): Promise<UserProfile | undefined>;
  saveUser(user: UserProfile): Promise<UserProfile>;
  consumeRateLimit(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface PaymentRecord { time: string; pouchId: string; merchantId: string; orderId: string; amount: number; txSignature: string }
export interface PriceRecord { time: string; merchantId: string; productId: string; unitPrice: number; inStock: boolean }

export function sameOperation(a: VaultOperation, b: VaultOperation): boolean {
  return a.id === b.id && a.kind === b.kind && a.pouchId === b.pouchId && a.txSignature === b.txSignature && a.signedTransaction === b.signedTransaction && a.lastValidBlockHeight === b.lastValidBlockHeight && a.createdAt === b.createdAt;
}

export function validateRateLimit(key: string, windowMs: number, max: number): void {
  if (!key || key.length > 512 || !Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(max) || max <= 0) throw new Error("Invalid rate limit configuration");
}

/** A pouch as stored: carries its owner. Never send ownerEmail over the API, use publicPouch(). */
export type StoredPouch = Pouch & { ownerEmail?: string };
export function publicPouch(p: StoredPouch): Pouch {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { ownerEmail: _o, ...rest } = p;
  return rest;
}

export type UserProfile = { email: string; displayName?: string; avatar?: string; wallet?: string; createdAt: string; updatedAt: string };

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
