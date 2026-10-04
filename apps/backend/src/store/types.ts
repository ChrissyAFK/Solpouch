import type { Order, Pouch, SpendPoint, TopUp, ShoppingList, Withdrawal } from "@solpouch/shared";

/** Profile edit. A wallet here is store-internal only: routes link wallets through setWallet. */
export type UserPatch = { displayName?: string | null; avatar?: string | null; wallet?: string | null };

export class StoreConflictError extends Error {
  constructor(message = "Record changed; reload it before retrying") {
    super(message);
    this.name = "StoreConflictError";
  }
}
/** setWallet refused because the account already links a different wallet. Unlink (setWallet null) first. */
export class WalletAlreadyLinkedError extends StoreConflictError {
  constructor() {
    super("Unlink your current wallet before linking another");
    this.name = "WalletAlreadyLinkedError";
  }
}
export interface VaultOperation {
  id: string;
  kind: "pay" | "topup" | "withdraw";
  pouchId: string;
  txSignature: string;
  signedTransaction: string;
  lastValidBlockHeight: number;
  createdAt: string;
}
export interface AuthSession { id: string; email: string; name: string; picture: string; createdAt: string; expiresAt: string }
/** A pending "link this wallet to the signed-in account" proof, bound to one session and web origin. Single use. */
export interface AuthChallenge { id: string; wallet: string; email: string; sessionId: string; origin: string; message: string; expiresAt: string }

/** All reads and saves return detached values. Use the version returned by a save. */
export type StoredShoppingList = ShoppingList & { ownerEmail: string };
export interface Store {
  /** Idempotent per (txSignature, orderId): a payment already indexed from the chain is not added again. */
  recordPayment(p: PaymentRecord): Promise<void>;
  recordPrices(rows: PriceRecord[]): Promise<void>;
  spendSeries(pouchIds: string[], bucket: "hour" | "day", since: string): Promise<SpendPoint[]>;
  readonly persistentLists?: boolean;
  listShoppingLists(ownerEmail: string): Promise<StoredShoppingList[]>;
  getShoppingList(id: string): Promise<StoredShoppingList | undefined>;
  saveShoppingList(list: StoredShoppingList): Promise<StoredShoppingList>;
  deleteShoppingList(id: string, ownerEmail: string, version: number): Promise<void>;
  listPouches(ownerEmail?: string): Promise<StoredPouch[]>;
  getPouch(id: string): Promise<StoredPouch | undefined>;
  savePouch(p: StoredPouch): Promise<StoredPouch>;
  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;
  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
  getWithdrawal(id: string): Promise<Withdrawal | undefined>;
  saveWithdrawal(w: Withdrawal): Promise<Withdrawal>;
  /** Newest first. */
  listWithdrawals(pouchId: string): Promise<Withdrawal[]>;
  /** Status "holding" or "processing" with readyAt <= now, across all pouches (system use: payout sweeper). */
  listDueWithdrawals(now: Date): Promise<Withdrawal[]>;
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
  /** Partial profile edit (undefined leaves a field alone, null clears it). Routes never pass a wallet. */
  updateUser(email: string, patch: UserPatch, now: string): Promise<UserProfile>;
  /** Saves profile fields. A wallet is applied only as a first link (account unlinked or same wallet); it never changes or clears a linked wallet. Use setWallet. */
  saveUser(user: UserProfile): Promise<UserProfile>;
  findUserByWallet(wallet: string): Promise<UserProfile | undefined>;
  /**
   * Links (or with null unlinks) the account's wallet, creating the user row if needed. Linking is conditional and atomic:
   * it succeeds only when the account has no wallet or already has this one, else WalletAlreadyLinkedError.
   * StoreConflictError when another account holds the wallet.
   */
  setWallet(email: string, wallet: string | null): Promise<UserProfile>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  /** Deletes and returns the challenge if it exists and has not expired. */
  consumeChallenge(id: string): Promise<AuthChallenge | undefined>;
  consumeRateLimit(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

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

/** One decoded vault program event. Idempotency key: (signature, eventIndex). */
export interface VaultEventRecord {
  signature: string;
  /** Position of the event among this program's events in the transaction. */
  eventIndex: number;
  name: string;
  pouchAddress: string | null;
  amount: number | null;
  /** Event time (the program's clock when it carries one, else the block time). */
  time: string;
  slot: number;
  /** Decoded fields with keys as base58, numbers as decimal strings, byte arrays as hex. */
  data: Record<string, unknown>;
}
/** A payment as a row of the `payments` hypertable: a PaymentMade event, or a paid order written directly. */
export interface PaymentRecord {
  txSignature: string;
  /** Position of the PaymentMade event in its transaction; absent for a paid order written directly. */
  eventIndex?: number;
  time: string;
  /** Store pouch ID, or the pouch PDA address when no stored pouch has it. */
  pouchId: string;
  merchantId: string | null;
  /** 32 hex chars; equals orders.id for payments the backend made. */
  orderId: string;
  amount: number;
}
export interface IndexerCursor { signature: string; slot: number }

/** Storage for the chain indexer. Writes are idempotent per (signature, eventIndex). */
export interface PaymentIndex {
  /** Record one transaction's events and payments atomically; returns how many events were new. */
  recordVaultEvents(events: VaultEventRecord[], payments: PaymentRecord[]): Promise<number>;
  getIndexerCursor(name: string): Promise<IndexerCursor | undefined>;
  saveIndexerCursor(name: string, cursor: IndexerCursor): Promise<void>;
  /** Spend from indexed payments for these pouches, or undefined when none are indexed. */
  indexedSpend(pouchIds: string[], bucket: "day" | "hour"): Promise<SpendPoint[] | undefined>;
  /** Which of these order IDs (lowercase hex) have an indexed payment for these pouches. */
  indexedOrderIds(pouchIds: string[], orderIds: string[]): Promise<Set<string>>;
}
export function isPaymentIndex(store: Store): store is Store & PaymentIndex {
  return typeof (store as Partial<PaymentIndex>).indexedSpend === "function" && typeof (store as Partial<PaymentIndex>).recordVaultEvents === "function";
}
export function spendBucket(time: string, bucket: "day" | "hour"): string {
  const d = new Date(time);
  if (bucket === "day") d.setUTCHours(0, 0, 0, 0);
  else d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
