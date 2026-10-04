import type { Micros, Withdrawal } from "@solpouch/shared";
import type { Store } from "../store/types.js";
import { PaymentPending } from "../vault/recovery.js";
import { VaultRejected } from "../vault/types.js";
import { HttpError, type Deps } from "./orders.js";

/** Money promised to pending withdrawals: it stays in the balance but cannot be spent. */
export async function heldAmount(store: Store, pouchId: string): Promise<Micros> {
  const all = await store.listWithdrawals(pouchId);
  return all.filter((w) => w.status === "holding" || w.status === "processing").reduce((s, w) => s + w.amount, 0);
}

export async function completeWithdrawal(deps: Deps, id: string): Promise<Withdrawal> {
  const initial = await deps.store.getWithdrawal(id);
  if (!initial) throw new HttpError(404, "Withdrawal not found");
  return deps.store.withPouchLock(initial.pouchId, async () => {
    let w = (await deps.store.getWithdrawal(id))!;
    if (w.status === "completed") return w;
    if (w.status !== "holding" && w.status !== "processing") throw new HttpError(409, `Withdrawal is ${w.status}`);
    if (Date.now() < new Date(w.readyAt).getTime()) throw new HttpError(409, `Withdrawal is on hold until ${w.readyAt}`, "WithdrawalHolding");
    const pouch = await deps.store.getPouch(w.pouchId);
    if (!pouch) throw new HttpError(404, "Pouch not found");
    // Freezing pauses payouts; the next sweep after unfreezing pays it.
    if (pouch.frozen) return w;
    // A processing row with no journaled tx was never sent (the vault call failed before broadcast), so re-check the wallet.
    const neverSent = w.status === "processing" && !(await deps.store.getOperation(`withdraw:${w.id}`));
    if (w.status === "holding" || neverSent) {
      const owner = pouch.ownerEmail ? await deps.store.getUser(pouch.ownerEmail) : undefined;
      if (owner?.wallet !== w.toWallet) return deps.store.saveWithdrawal({ ...w, status: "failed", failReason: "WalletChanged" });
      if (w.status === "holding") w = await deps.store.saveWithdrawal({ ...w, status: "processing" });
    }
    try {
      const { txSignature } = await deps.vault.withdraw(w.pouchId, w.amount, w.toWallet, w.id);
      return await deps.store.saveWithdrawal({ ...w, status: "completed", txSignature });
    } catch (error) {
      if (error instanceof VaultRejected) return deps.store.saveWithdrawal({ ...w, status: "failed", failReason: error.code });
      // PaymentPending or unknown: stay processing so the sweeper retries.
      if (error instanceof PaymentPending) throw error;
      throw error;
    }
  });
}

/** Sweeper entry point. Never throws. Pass the base store, not a user-scoped one. */
export async function payDueWithdrawals(deps: Deps): Promise<void> {
  let due: Withdrawal[];
  try {
    due = await deps.store.listDueWithdrawals(new Date());
  } catch (e) {
    console.error("withdrawal payout", "list", e);
    return;
  }
  for (const w of due) {
    try {
      await completeWithdrawal(deps, w.id);
    } catch (e) {
      console.error("withdrawal payout", w.id, e);
    }
  }
}
