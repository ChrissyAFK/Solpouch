import { PaymentPending } from "../vault/recovery.js";
import { getOwnedPouch, HttpError, type Deps } from "./orders.js";

export async function completeTopUp(deps: Deps, ownerEmail: string, id: string) {
  const initial = await deps.store.getTopUp(id);
  if (!initial) throw new HttpError(404, "Top-up not found");
  return deps.store.withPouchLock(initial.pouchId, async () => {
    await getOwnedPouch(deps, initial.pouchId, ownerEmail);
    let topup = (await deps.store.getTopUp(id))!;
    if (topup.status === "completed") return topup;
    if (topup.status !== "cooling_down" && topup.status !== "processing") throw new HttpError(409, `Top-up is ${topup.status}`);
    if (Date.now() < new Date(topup.readyAt).getTime()) throw new HttpError(409, `Cooldown not over yet, ready at ${topup.readyAt}`, "CooldownActive");
    if (topup.status === "cooling_down") topup = await deps.store.saveTopUp({ ...topup, status: "processing" });
    try {
      const { txSignature } = await deps.vault.topUp(topup.pouchId, topup.amount, topup.id);
      return await deps.store.saveTopUp({ ...topup, status: "completed", txSignature, completedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof PaymentPending) throw new HttpError(503, error.message, "PaymentPending");
      throw new HttpError(503, "Top-up is not confirmed yet. Retry this top-up to check its status.", "PaymentPending");
    }
  });
}
