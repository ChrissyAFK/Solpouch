import type { Order, Pouch, SpendPoint, TopUp } from "@solpouch/shared";

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
/** A pending "link this wallet to the signed-in account" proof, bound to one session and web origin. Single use. */
export interface AuthChallenge { id: string; wallet: string; email: string; sessionId: string; origin: string; message: string; expiresAt: string }

/** All reads and saves return detached values. Use the version returned by a save. */
export interface Store {
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
  /** Saves profile fields. Never changes the linked wallet; use setWallet. */
  saveUser(user: UserProfile): Promise<UserProfile>;
  findUserByWallet(wallet: string): Promise<UserProfile | undefined>;
  /** Links (or with null unlinks) the account's wallet, creating the user row if needed. StoreConflictError when another account holds it. */
  setWallet(email: string, wallet: string | null): Promise<UserProfile>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  /** Deletes and returns the challenge if it exists and has not expired. */
  consumeChallenge(id: string): Promise<AuthChallenge | undefined>;
  consumeRateLimit(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

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
/** A PaymentMade event as a row of the `payments` hypertable. */
export interface PaymentRecord {
  txSignature: string;
  eventIndex: number;
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
