import type { Pouch } from "@solpouch/shared";
import { HttpError, type Deps } from "./orders.js";

/** Refresh the database mirror without signing or writing anything on chain. */
export async function reconcilePouch(deps: Deps, id: string): Promise<Pouch> {
  const initial = await deps.store.getPouch(id);
  if (!initial) throw new HttpError(404, "Pouch not found");
  if (deps.vault.authorizedOwner === undefined) return initial;
  return deps.store.withPouchLock(id, async () => {
    try {
      const state = deps.vault.getState ? await deps.vault.getState(id) : await deps.vault.getBalance(id);
      const pouch = await deps.store.getPouch(id);
      if (!pouch) throw new HttpError(404, "Pouch not found");
      if (Object.entries(state).every(([key, value]) => JSON.stringify(pouch[key as keyof Pouch]) === JSON.stringify(value))) return pouch;
      return await deps.store.savePouch({ ...pouch, ...state });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw error;
      throw new HttpError(503, "Unable to refresh this pouch. Try again.");
    }
  });
}

export async function reconcilePouches(deps: Deps): Promise<Pouch[]> {
  const rows = await deps.store.listPouches(); const current: Pouch[] = [];
  for (const row of rows) current.push(await reconcilePouch(deps, row.id));
  return current;
}
