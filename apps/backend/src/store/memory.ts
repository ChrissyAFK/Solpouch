import { toMicros, type Order, type Pouch, type TopUp } from "@solpouch/shared";
import type { Store, StoredPouch, UserProfile } from "./types.js";

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
      allowedMerchantIds: ["mountain-market"],
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
  private users = new Map<string, UserProfile>();

  constructor(seed: StoredPouch[] = seedPouches(), legacyOwnerEmail?: string) {
    const legacy = legacyOwnerEmail?.trim().toLowerCase();
    for (const p of seed) this.pouches.set(p.id, legacy && !p.ownerEmail ? { ...p, ownerEmail: legacy } : p);
  }

  async listPouches(ownerEmail?: string) {
    const all = [...this.pouches.values()];
    return ownerEmail ? all.filter((p) => p.ownerEmail === ownerEmail) : all;
  }
  async getPouch(id: string) {
    return this.pouches.get(id);
  }
  async savePouch(p: StoredPouch) {
    const prev = this.pouches.get(p.id);
    if (p.ownerEmail === undefined && prev?.ownerEmail) p.ownerEmail = prev.ownerEmail;
    this.pouches.set(p.id, p);
    return p;
  }
  async listOrders(pouchId?: string) {
    const all = [...this.orders.values()];
    return (pouchId ? all.filter((o) => o.pouchId === pouchId) : all).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async getOrder(id: string) {
    return this.orders.get(id);
  }
  async saveOrder(o: Order) {
    this.orders.set(o.id, o);
    return o;
  }
  async getTopUp(id: string) {
    return this.topups.get(id);
  }
  async saveTopUp(t: TopUp) {
    this.topups.set(t.id, t);
    return t;
  }
  async listTopUps(pouchId: string) {
    return [...this.topups.values()]
      .filter((t) => t.pouchId === pouchId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getUser(email: string) {
    return this.users.get(email);
  }
  async saveUser(u: UserProfile) {
    this.users.set(u.email, u);
    return u;
  }
}
