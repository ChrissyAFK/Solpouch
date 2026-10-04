import { randomBytes } from "node:crypto";
import type { Micros, Pouch } from "@solpouch/shared";
import type { Store } from "../store/types.js";
import { fakeAddress } from "../store/memory.js";
import { allowedPayTos } from "./allow.js";
import { VaultRejected, type VaultClient } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const resultsByStore = new WeakMap<Store, Map<string, string>>();
const sig = () => "mock" + randomBytes(32).toString("hex");

/**
 * Enforces the same rules, in the same order, as the solpouch_vault program.
 * The Store holds the pouch state; this class mutates it like the chain would.
 */
export class MockVaultClient implements VaultClient {
  private dayStart = new Map<string, number>();
  private outcomes: Map<string, string>;

  constructor(
    private store: Store,
    /** Resolves a merchant id to its payTo address, to check the allowlist by address. */
    private payToOf: (merchantId: string) => string | undefined,
    private now: () => number = Date.now,
  ) {
    this.outcomes = resultsByStore.get(store) ?? new Map();
    resultsByStore.set(store, this.outcomes);
  }

  async createPouch(pouch: Pouch) {
    this.dayStart.set(pouch.id, this.now());
    return { address: pouch.address || fakeAddress() };
  }

  async topUp(pouchId: string, amount: Micros, operationId?: string) {
    const key = operationId ? `topup:${operationId}` : undefined;
    const previous = key && this.outcomes.get(key);
    if (previous) return { txSignature: previous };
    const p = await this.mustGet(pouchId);
    p.balance += amount;
    await this.store.savePouch(p);
    const txSignature = sig();
    if (key) this.outcomes.set(key, txSignature);
    return { txSignature };
  }

  async withdraw(pouchId: string, amount: Micros, _toWallet: string, operationId?: string) {
    const key = operationId ? `withdraw:${operationId}` : undefined;
    const previous = key && this.outcomes.get(key);
    if (previous) return { txSignature: previous };
    const p = await this.mustGet(pouchId);
    if (amount > p.balance) throw new VaultRejected("InsufficientFunds");
    p.balance -= amount;
    await this.store.savePouch(p);
    const txSignature = sig();
    if (key) this.outcomes.set(key, txSignature);
    return { txSignature };
  }

  async pay(pouch: Pouch, merchantPayTo: string, amount: Micros, orderId: string) {
    const key = `pay:${orderId}`;
    const previous = this.outcomes.get(key);
    if (previous) return { txSignature: previous };
    const p = await this.mustGet(pouch.id);
    if (p.frozen) throw new VaultRejected("PouchFrozen");
    const allowed = allowedPayTos(p, this.payToOf);
    if (!allowed.includes(merchantPayTo)) throw new VaultRejected("MerchantNotAllowed");
    if (amount > p.maxPerOrder) throw new VaultRejected("OverPerOrderLimit");
    const now = this.now();
    const start = this.dayStart.get(p.id) ?? now;
    if (now - start >= DAY_MS) {
      p.spentToday = 0;
      this.dayStart.set(p.id, now);
    } else if (!this.dayStart.has(p.id)) {
      this.dayStart.set(p.id, now);
    }
    if (p.spentToday + amount > p.dailyLimit) throw new VaultRejected("OverDailyLimit");
    if (amount > p.balance) throw new VaultRejected("InsufficientFunds");
    p.balance -= amount;
    p.spentToday += amount;
    await this.store.savePouch(p);
    const txSignature = sig();
    this.outcomes.set(key, txSignature);
    return { txSignature };
  }

  async freeze(pouchId: string) {
    const p = await this.mustGet(pouchId);
    p.frozen = true;
    await this.store.savePouch(p);
    return { txSignature: sig() };
  }

  async unfreeze(pouchId: string) {
    const p = await this.mustGet(pouchId);
    p.frozen = false;
    await this.store.savePouch(p);
    return { txSignature: sig() };
  }

  async getBalance(pouchId: string) {
    const p = await this.mustGet(pouchId);
    return { balance: p.balance, spentToday: p.spentToday };
  }

  async updateRules(_pouch: Pouch) {
    return { txSignature: sig() };
  }

  private async mustGet(id: string) {
    const p = await this.store.getPouch(id);
    if (!p) throw new Error(`unknown pouch ${id}`);
    return p;
  }
}
