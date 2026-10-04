import type { StoredPouch } from "../store/types.js";
import type { Pouch } from "@solpouch/shared";
import { HttpError, type Deps } from "./orders.js";

/** Refresh the database mirror without signing or writing anything on chain. */
export async function reconcilePouch(deps: Deps, id: string): Promise<StoredPouch> {
  const initial = await deps.store.getPouch(id);
  if (!initial) throw new HttpError(404, "Pouch not found");
  if (deps.vault.authorizedOwner === undefined) return initial;
  try {
    // Reading chain state takes no lock; only a write to the mirror does.
    const state = deps.vault.getState ? await deps.vault.getState(id) : await deps.vault.getBalance(id);
    const same = (pouch: Pouch) => Object.entries(state).every(([key, value]) => JSON.stringify(pouch[key as keyof Pouch]) === JSON.stringify(value));
    if (same(initial)) return initial;
    return await deps.store.withPouchLock(id, async () => {
      const pouch = await deps.store.getPouch(id);
      if (!pouch) throw new HttpError(404, "Pouch not found");
      // A payment may have completed after the optimistic read. Re-read while
      // holding the shared mutation lock before replacing the mirror.
      const current = deps.vault.getState ? await deps.vault.getState(id) : await deps.vault.getBalance(id);
      if (Object.entries(current).every(([key,value]) => JSON.stringify(pouch[key as keyof Pouch]) === JSON.stringify(value))) return pouch;
      return deps.store.savePouch({ ...pouch, ...current });
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    throw new HttpError(503, "Unable to refresh this pouch. Try again.");
  }
}

export async function reconcilePouches(deps: Deps): Promise<Pouch[]> {
  const rows = await deps.store.listPouches(); const current: Pouch[] = [];
  for (const row of rows) current.push(await reconcilePouch(deps, row.id));
  return current;
}
