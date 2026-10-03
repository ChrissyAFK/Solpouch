import type { Micros, Pouch } from "@solpouch/shared";
import type { Store } from "../store/types.js";
import type { VaultClient } from "./types.js";

/**
 * Wraps the chain client so the store mirrors the chain after every write,
 * the way MockVaultClient updates the store itself. The chain stays the source of truth.
 */
export class SyncedVaultClient implements VaultClient {
  constructor(private inner: VaultClient, private store: Store) {}

  private async refresh(pouchId: string, patch: Partial<Pouch> = {}) {
    const p = await this.store.getPouch(pouchId);
    if (!p) return;
    const { balance, spentToday } = await this.inner.getBalance(pouchId);
    await this.store.savePouch({ ...p, ...patch, balance, spentToday });
  }

  createPouch(pouch: Pouch) {
    return this.inner.createPouch(pouch);
  }

  async topUp(pouchId: string, amount: Micros) {
    const r = await this.inner.topUp(pouchId, amount);
    await this.refresh(pouchId);
    return r;
  }

  async pay(pouch: Pouch, merchantPayTo: string, amount: Micros, orderId: string) {
    const r = await this.inner.pay(pouch, merchantPayTo, amount, orderId);
    await this.refresh(pouch.id);
    return r;
  }

  async freeze(pouchId: string) {
    const r = await this.inner.freeze(pouchId);
    await this.refresh(pouchId, { frozen: true });
    return r;
  }

  async unfreeze(pouchId: string) {
    const r = await this.inner.unfreeze(pouchId);
    await this.refresh(pouchId, { frozen: false });
    return r;
  }

  getBalance(pouchId: string) {
    return this.inner.getBalance(pouchId);
  }

  updateRules(pouch: Pouch) {
    return this.inner.updateRules(pouch);
  }
}
