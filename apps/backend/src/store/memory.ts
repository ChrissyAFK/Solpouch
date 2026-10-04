import { toMicros, type Order, type Pouch, type TopUp } from "@solpouch/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { StoreConflictError, sameOperation, validateRateLimit, type Store, type VaultOperation, type AuthSession, type AuthChallenge, type StoredPouch, type UserProfile } from "./types.js";

// TODO: PostgresStore backed by Tiger Data (see db/schema.sql). Swap in src/index.ts.

export function fakeAddress(): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 44; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function seedPouches(): Pouch[] {
  const base = { spentToday: 0, frozen: false };
  return [
    {
      ...base,
      id: "uber-eats",
      address: fakeAddress(),
      name: "Uber Eats",
      balance: toMicros(100),
      maxPerOrder: toMicros(25),
      dailyLimit: toMicros(40),
      confirmAbove: 0,
      allowedMerchantIds: ["thai-express"],
    },
    {
      ...base,
      id: "groceries",
      address: fakeAddress(),
      name: "Groceries",
      balance: toMicros(300),
      maxPerOrder: toMicros(120),
      dailyLimit: toMicros(150),
      confirmAbove: toMicros(30),
      allowedMerchantIds: [],
    },
    {
      ...base,
      id: "kim-materials",
      address: fakeAddress(),
      name: "Kim job: materials",
      balance: toMicros(10000),
      maxPerOrder: toMicros(2000),
      dailyLimit: toMicros(5000),
      confirmAbove: 0,
      allowedMerchantIds: ["burnaby-builders"],
    },
  ];
}

export class MemoryStore implements Store {
  private pouches = new Map<string, StoredPouch>();
  private orders = new Map<string, Order>();
  private topups = new Map<string, TopUp>();
  private operations = new Map<string, VaultOperation>();
  private users = new Map<string, UserProfile>();
  private challenges = new Map<string, AuthChallenge>();
  private sessions = new Map<string, AuthSession>();
  private rateLimits = new Map<string, { hits: number; expiresAt: number }>();
  private nextCleanupAt = 0;
  private cleanupExpired() {
    const now = Date.now();
    if (now < this.nextCleanupAt) return;
    this.nextCleanupAt = now + 60_000;
    const sweep = <T>(map: Map<string, T>, expiresAt: (value: T) => number) => {
      const limit = Math.min(1000, map.size);
      let scanned = 0;
      for (const [id, value] of map) {
        if (scanned++ >= limit) break;
        map.delete(id);
        // Rotate survivors so later bounded sweeps eventually inspect every entry.
        if (expiresAt(value) > now) map.set(id, value);
      }
    };
    sweep(this.challenges, (record) => Date.parse(record.expiresAt));
    sweep(this.sessions, (record) => Date.parse(record.expiresAt));
    sweep(this.rateLimits, (bucket) => bucket.expiresAt);
  }
  private locks = new Map<string, Promise<void>>();
  private heldLocks = new AsyncLocalStorage<Set<string>>();

  constructor(seed: StoredPouch[] = [], legacyOwnerEmail?: string) {
    for (const p of seed) this.pouches.set(p.id, structuredClone({ ...p, version: p.version ?? 0, ...(legacyOwnerEmail && !p.ownerEmail ? {ownerEmail: legacyOwnerEmail.trim().toLowerCase()} : {}) }));
  }
  private save<T extends { id: string; version?: number; createdAt?: string }>(map: Map<string, T>, record: T): T {
    const current = map.get(record.id);
    if (current ? record.version !== current.version : record.version !== undefined) throw new StoreConflictError();
    if (current?.createdAt && record.createdAt && new Date(current.createdAt).toISOString() !== new Date(record.createdAt).toISOString()) throw new StoreConflictError("Creation time cannot change");
    const saved = structuredClone({ ...record, version: (current?.version ?? 0) + 1 });
    map.set(record.id, saved);
    return structuredClone(saved);
  }
  async listPouches(ownerEmail?: string) { return structuredClone([...this.pouches.values()].filter(p => !ownerEmail || p.ownerEmail === ownerEmail)); }
  async getPouch(id: string) { return structuredClone(this.pouches.get(id)); }
  async savePouch(p: StoredPouch) { return this.save(this.pouches, p); }
  async listOrders(pouchId?: string) {
    return structuredClone([...this.orders.values()].filter((o) => !pouchId || o.pouchId === pouchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async getOrder(id: string) { return structuredClone(this.orders.get(id)); }
  async saveOrder(o: Order) { return this.save(this.orders, o); }
  async getTopUp(id: string) { return structuredClone(this.topups.get(id)); }
  async saveTopUp(t: TopUp) { return this.save(this.topups, t); }
  async withPouchLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const held = this.heldLocks.getStore();
    if (held?.has(id)) return fn();
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, next);
    await previous;
    try { return await this.heldLocks.run(new Set([...(held ?? []), id]), fn); }
    finally { release(); if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async applyMockOperation(pouch: StoredPouch, operation: VaultOperation) {
    return this.withPouchLock(pouch.id,async()=> {
      if(this.operations.has(operation.id)) throw new StoreConflictError("Operation already applied");
      this.save(this.pouches,pouch);
      this.operations.set(operation.id,structuredClone(operation));
    });
  }
  async getOperation(id: string) { return structuredClone(this.operations.get(id)); }
  async saveOperation(record: VaultOperation) {
    const current = this.operations.get(record.id);
    if (current && !sameOperation(current, record)) throw new StoreConflictError("Operation is immutable");
    this.operations.set(record.id, structuredClone(record));
  }
  async saveSession(record: AuthSession) {
    this.cleanupExpired();
    if (this.sessions.has(record.id)) throw new StoreConflictError("Session already exists");
    this.sessions.set(record.id, structuredClone(record));
  }
  async getSession(tokenHash: string) {
    const record = this.sessions.get(tokenHash);
    if (record && Date.parse(record.expiresAt) > Date.now()) return structuredClone(record);
    this.sessions.delete(tokenHash);
    return undefined;
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async listSessions(email: string) { return structuredClone([...this.sessions.values()].filter(s => s.email === email && Date.parse(s.expiresAt) > Date.now())); }
  async deleteSessions(email: string) { for (const [id,s] of this.sessions) if (s.email === email) this.sessions.delete(id); }
  async listTopUps(pouchId: string) { return structuredClone([...this.topups.values()].filter(t=>t.pouchId===pouchId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))); }
  async getUser(email: string) { return structuredClone(this.users.get(email)); }
  async findUserByWallet(wallet: string) { return structuredClone([...this.users.values()].find(u => u.wallet === wallet)); }
  async saveUser(user: UserProfile) {
    if (user.wallet && [...this.users.values()].some(u => u.wallet === user.wallet && u.email !== user.email)) throw new StoreConflictError("This wallet is linked to another account");
    this.users.set(user.email, structuredClone(user)); return structuredClone(user);
  }
  async saveChallenge(record: AuthChallenge) {
    this.cleanupExpired();
    if (this.challenges.has(record.id)) throw new StoreConflictError("Challenge already exists");
    this.challenges.set(record.id, structuredClone(record));
  }
  async consumeChallenge(id: string) {
    const record = this.challenges.get(id); this.challenges.delete(id);
    return record && Date.parse(record.expiresAt) > Date.now() ? structuredClone(record) : undefined;
  }
  async consumeRateLimit(key: string, windowMs: number, max: number) {
    validateRateLimit(key, windowMs, max);
    const now = Date.now();
    this.cleanupExpired();
    const previous = this.rateLimits.get(key);
    const bucket = previous && previous.expiresAt > now ? previous : { hits: 0, expiresAt: now + windowMs };
    bucket.hits++;
    this.rateLimits.set(key, bucket);
    return { allowed: bucket.hits <= max, retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
  }
}
