import type { Micros, Pouch } from "@solpouch/shared";
import type { Store } from "../store/types.js";
import type { VaultClient } from "./types.js";

/**
 * Wraps the chain client so the store mirrors the chain after every write,
 * the way MockVaultClient updates the store itself. The chain stays the source of truth.
 */
export class SyncedVaultClient implements VaultClient {
  constructor(private inner: VaultClient, private store: Store) {}

  get authorizedOwner() { return this.inner.authorizedOwner; }

  get getState() {
    const inner = this.inner;
    if (!inner.getState) return undefined;
    return async (pouchId: string, stored?: Pouch) => inner.getState!(pouchId, stored ?? await this.store.getPouch(pouchId));
  }

  private async refresh(pouchId: string, patch: Partial<Pouch> = {}) {
    const p = await this.store.getPouch(pouchId);
    if (!p) return;
    const state = this.inner.getState ? await this.inner.getState(pouchId, p) : await this.inner.getBalance(pouchId);
    await this.store.savePouch({ ...p, ...patch, ...state });
  }

  createPouch(pouch: Pouch) {
    return this.inner.createPouch(pouch);
  }

  async topUp(pouchId: string, amount: Micros, operationId?: string) {
    const r = await this.inner.topUp(pouchId, amount, operationId);
    await this.refresh(pouchId).catch(() => { /* Chain result is authoritative; startup or a later successful write repairs the cache. */ });
    return r;
  }

  async pay(pouch: Pouch, merchantPayTo: string, amount: Micros, orderId: string) {
    const r = await this.inner.pay(pouch, merchantPayTo, amount, orderId);
    await this.refresh(pouch.id).catch(() => { /* Never turn a confirmed payment into a retryable payment failure. */ });
    return r;
  }

  async freeze(pouchId: string) {
    const r = await this.inner.freeze(pouchId);
    await this.markFrozen(pouchId, true);
    return r;
  }

  async unfreeze(pouchId: string) {
    const r = await this.inner.unfreeze(pouchId);
    await this.markFrozen(pouchId, false);
    return r;
  }

  /** The chain write already landed; a failed refresh must still record the new frozen flag. */
  private async markFrozen(pouchId: string, frozen: boolean) {
    try {
      await this.refresh(pouchId, { frozen });
    } catch {
      const p = await this.store.getPouch(pouchId);
      if (p) await this.store.savePouch({ ...p, frozen }).catch(() => { /* a later reconcile repairs the mirror */ });
    }
  }

  getBalance(pouchId: string) {
    return this.inner.getBalance(pouchId);
  }

  updateRules(pouch: Pouch) {
    return this.inner.updateRules(pouch);
  }
}
