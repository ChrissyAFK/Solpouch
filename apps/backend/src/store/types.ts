import type { Order, Pouch, TopUp } from "@solpouch/shared";

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
  saveUser(user: UserProfile): Promise<UserProfile>;
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

export type UserProfile = { email: string; displayName?: string; avatar?: string; createdAt: string; updatedAt: string };
