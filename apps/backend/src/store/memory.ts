import { toMicros, type Order, type Pouch, type SpendPoint, type TopUp } from "@solpouch/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { StoreConflictError, sameOperation, spendBucket, validateRateLimit, type Store, type VaultOperation, type AuthSession, type AuthChallenge, type StoredPouch, type UserProfile, type PaymentIndex, type VaultEventRecord, type PaymentRecord, type IndexerCursor } from "./types.js";

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
      confirmAbove: 0,
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

export class MemoryStore implements Store, PaymentIndex {
  private pouches = new Map<string, StoredPouch>();
  private orders = new Map<string, Order>();
  private topups = new Map<string, TopUp>();
  private operations = new Map<string, VaultOperation>();
  private users = new Map<string, UserProfile>();
  private sessions = new Map<string, AuthSession>();
  private challenges = new Map<string, AuthChallenge>();
  private rateLimits = new Map<string, { hits: number; expiresAt: number }>();
  private vaultEvents = new Map<string, VaultEventRecord>();
  private payments = new Map<string, PaymentRecord>();
  private cursors = new Map<string, IndexerCursor>();
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
    sweep(this.sessions, (record) => Date.parse(record.expiresAt));
    sweep(this.challenges, (record) => Date.parse(record.expiresAt));
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
  async saveUser(user: UserProfile) {
    const { wallet: _ignored, ...fields } = user; // eslint-disable-line @typescript-eslint/no-unused-vars
    const current = this.users.get(user.email);
    const saved = { ...fields, ...(current?.wallet ? { wallet: current.wallet } : {}) };
    this.users.set(user.email, structuredClone(saved));
    return structuredClone(saved);
  }
  async findUserByWallet(wallet: string) {
    for (const u of this.users.values()) if (u.wallet === wallet) return structuredClone(u);
    return undefined;
  }
  async setWallet(email: string, wallet: string | null) {
    const holder = wallet ? await this.findUserByWallet(wallet) : undefined;
    if (holder && holder.email !== email) throw new StoreConflictError("This wallet is linked to another account");
    const now = new Date().toISOString();
    const { wallet: _old, ...current } = this.users.get(email) ?? { email, createdAt: now, updatedAt: now }; // eslint-disable-line @typescript-eslint/no-unused-vars
    const saved: UserProfile = { ...current, ...(wallet ? { wallet } : {}), updatedAt: now };
    this.users.set(email, structuredClone(saved));
    return structuredClone(saved);
  }
  async saveChallenge(record: AuthChallenge) {
    this.cleanupExpired();
    if (this.challenges.has(record.id)) throw new StoreConflictError("Challenge already exists");
    this.challenges.set(record.id, structuredClone(record));
  }
  async consumeChallenge(id: string) {
    const record = this.challenges.get(id);
    this.challenges.delete(id);
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
  async recordVaultEvents(events: VaultEventRecord[], payments: PaymentRecord[]) {
    let inserted = 0;
    for (const e of events) {
      const key = `${e.signature}#${e.eventIndex}`;
      if (this.vaultEvents.has(key)) continue;
      this.vaultEvents.set(key, structuredClone(e));
      inserted++;
      const p = payments.find((x) => x.txSignature === e.signature && x.eventIndex === e.eventIndex);
      if (p && !this.payments.has(key)) this.payments.set(key, structuredClone(p));
    }
    return inserted;
  }
  async getIndexerCursor(name: string) { return structuredClone(this.cursors.get(name)); }
  async saveIndexerCursor(name: string, cursor: IndexerCursor) { this.cursors.set(name, structuredClone(cursor)); }
  async indexedSpend(pouchIds: string[], bucket: "day" | "hour") {
    const ids = new Set(pouchIds);
    const rows = [...this.payments.values()].filter((p) => ids.has(p.pouchId));
    if (!rows.length) return undefined;
    const points = new Map<string, SpendPoint>();
    for (const p of rows) {
      const b = spendBucket(p.time, bucket);
      const key = `${p.pouchId}|${b}`;
      const pt = points.get(key) ?? { bucket: b, pouchId: p.pouchId, spent: 0, orders: 0 };
      pt.spent += p.amount;
      pt.orders += 1;
      points.set(key, pt);
    }
    return [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.pouchId.localeCompare(b.pouchId));
  }
}
