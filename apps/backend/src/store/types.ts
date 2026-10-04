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
export interface AuthChallenge { id: string; wallet: string; message: string; expiresAt: string }
export interface AuthSession { tokenHash: string; wallet: string; expiresAt: string; scope?: "web" | "voice"; parentTokenHash?: string }

/** All reads and saves return detached values. Use the version returned by a save. */
export interface Store {
  listPouches(): Promise<Pouch[]>;
  getPouch(id: string): Promise<Pouch | undefined>;
  savePouch(p: Pouch): Promise<Pouch>;
  listOrders(pouchId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order | undefined>;
  saveOrder(o: Order): Promise<Order>;
  getTopUp(id: string): Promise<TopUp | undefined>;
  saveTopUp(t: TopUp): Promise<TopUp>;
  withPouchLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
  getOperation(id: string): Promise<VaultOperation | undefined>;
  saveOperation(record: VaultOperation): Promise<void>;
  saveChallenge(challenge: AuthChallenge): Promise<void>;
  consumeChallenge(id: string): Promise<AuthChallenge | undefined>;
  saveSession(session: AuthSession): Promise<void>;
  getSession(tokenHash: string): Promise<AuthSession | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  consumeRateLimit(key: string, windowMs: number, max: number): Promise<{ allowed: boolean; retryAfter: number }>;
}

export function sameOperation(a: VaultOperation, b: VaultOperation): boolean {
  return a.id === b.id && a.kind === b.kind && a.pouchId === b.pouchId && a.txSignature === b.txSignature && a.signedTransaction === b.signedTransaction && a.lastValidBlockHeight === b.lastValidBlockHeight && a.createdAt === b.createdAt;
}

export function validateRateLimit(key: string, windowMs: number, max: number): void {
  if (!key || key.length > 512 || !Number.isSafeInteger(windowMs) || windowMs <= 0 || !Number.isSafeInteger(max) || max <= 0) throw new Error("Invalid rate limit configuration");
}
