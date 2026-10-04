import type { Order, Pouch, TopUp } from "@solpouch/shared";

/** A pouch as stored: carries its owner. Never send ownerEmail over the API, use publicPouch(). */
export type StoredPouch = Pouch & { ownerEmail?: string };
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
}

export function sameOperation(a: VaultOperation, b: VaultOperation): boolean {
  return a.id === b.id && a.kind === b.kind && a.pouchId === b.pouchId && a.txSignature === b.txSignature && a.signedTransaction === b.signedTransaction && a.lastValidBlockHeight === b.lastValidBlockHeight && a.createdAt === b.createdAt;
}

export function validateRateLimit(key: string, windowMs: number, max: number): void {
  if (!key || key.length > 512 || !Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(max) || max <= 0) throw new Error("Invalid rate limit configuration");
}
