import { toMicros, type Order, type Pouch, type TopUp, type Withdrawal } from "@solpouch/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { StoreConflictError, sameOperation, validateRateLimit, type Store, type StoredPouch, type UserProfile, type VaultOperation, type AuthChallenge, type UserPatch } from "./types.js";

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
      allowedMerchantIds: [], // any store
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
  private withdrawals = new Map<string, Withdrawal>();
  private users = new Map<string, UserProfile>();
  private operations = new Map<string, VaultOperation>();
  private challenges = new Map<string, AuthChallenge>();
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
    sweep(this.rateLimits, (bucket) => bucket.expiresAt);
  }
  private locks = new Map<string, Promise<void>>();
  private heldLocks = new AsyncLocalStorage<Set<string>>();

  constructor(seed: StoredPouch[] = seedPouches(), legacyOwnerEmail?: string) {
    const legacy = legacyOwnerEmail?.trim().toLowerCase();
    for (const p of seed) this.pouches.set(p.id, structuredClone({ ...p, version: p.version ?? 0, ...(legacy && !p.ownerEmail ? { ownerEmail: legacy } : {}) }));
  }
  private save<T extends { id: string; version?: number; createdAt?: string }>(map: Map<string, T>, record: T): T {
    const current = map.get(record.id);
    if (current ? record.version !== current.version : record.version !== undefined) throw new StoreConflictError();
    if (current?.createdAt && record.createdAt && new Date(current.createdAt).toISOString() !== new Date(record.createdAt).toISOString()) throw new StoreConflictError("Creation time cannot change");
    const saved = structuredClone({ ...record, version: (current?.version ?? 0) + 1 });
    map.set(record.id, saved);
    return structuredClone(saved);
  }
  async listPouches(ownerEmail?: string) {
    const all = [...this.pouches.values()];
    return structuredClone(ownerEmail ? all.filter((p) => p.ownerEmail === ownerEmail) : all);
  }
  async getPouch(id: string) { return structuredClone(this.pouches.get(id)); }
  async savePouch(p: StoredPouch) {
    const prev = this.pouches.get(p.id);
    return this.save(this.pouches, p.ownerEmail === undefined && prev?.ownerEmail ? { ...p, ownerEmail: prev.ownerEmail } : p);
  }
  async listOrders(pouchId?: string) {
    return structuredClone([...this.orders.values()].filter((o) => !pouchId || o.pouchId === pouchId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async getOrder(id: string) { return structuredClone(this.orders.get(id)); }
  async saveOrder(o: Order) { return this.save(this.orders, o); }
  async getTopUp(id: string) { return structuredClone(this.topups.get(id)); }
  async saveTopUp(t: TopUp) { return this.save(this.topups, t); }
  async listTopUps(pouchId: string) {
    return structuredClone([...this.topups.values()]
      .filter((t) => t.pouchId === pouchId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async getWithdrawal(id: string) { return structuredClone(this.withdrawals.get(id)); }
  async saveWithdrawal(w: Withdrawal) { return this.save(this.withdrawals, w); }
  async listWithdrawals(pouchId: string) {
    return structuredClone([...this.withdrawals.values()]
      .filter((w) => w.pouchId === pouchId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async listDueWithdrawals(now: Date) {
    return structuredClone([...this.withdrawals.values()]
      .filter((w) => (w.status === "holding" || w.status === "processing") && Date.parse(w.readyAt) <= now.getTime())
      .sort((a, b) => a.readyAt.localeCompare(b.readyAt)));
  }
  async getUser(email: string) { return structuredClone(this.users.get(email)); }
  private assertWalletFree(email: string, wallet: string | undefined) {
    if (!wallet) return;
    for (const other of this.users.values()) if (other.email !== email && other.wallet === wallet) throw new StoreConflictError("This wallet is linked to another account");
  }
  async saveUser(u: UserProfile) {
    this.assertWalletFree(u.email, u.wallet);
    this.users.set(u.email, structuredClone(u));
    return structuredClone(u);
  }
  async updateUser(email: string, patch: UserPatch, now: string) {
    const prev = this.users.get(email) ?? { email, createdAt: now, updatedAt: now };
    const next: UserProfile = { ...prev, updatedAt: now };
    for (const k of ["displayName", "avatar", "wallet"] as const) {
      if (patch[k] === undefined) continue;
      if (patch[k] === null) delete next[k];
      else next[k] = patch[k] as string;
    }
    this.assertWalletFree(email, next.wallet);
    this.users.set(email, structuredClone(next));
    return structuredClone(next);
  }
  async findUserByWallet(wallet: string) {
    for (const u of this.users.values()) if (u.wallet === wallet) return structuredClone(u);
    return undefined;
  }
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
  async getOperation(id: string) { return structuredClone(this.operations.get(id)); }
  async saveOperation(record: VaultOperation) {
    const current = this.operations.get(record.id);
    if (current && !sameOperation(current, record)) throw new StoreConflictError("Operation is immutable");
    this.operations.set(record.id, structuredClone(record));
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
    return { allowed: bucket.hits <= max, retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
  }
}
