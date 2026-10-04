import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Allocation } from "@solpouch/shared";
import type { AuthEnv } from "../auth/session.js";
import { getOwnedPouch, HttpError, type Deps } from "../services/orders.js";
import { StoreConflictError, type StoredAllocation } from "../store/types.js";
import { createRpcAllocationChain, type AllocationChain } from "../vault/allocationChain.js";

const prepareBody = z.object({
  pouchId: z.string().max(100),
  amount: z.number().int().positive().max(10_000_000_000),
});
const completeBody = z.object({ signature: z.string().min(32).max(120) });

const publicAllocation = ({ ownerEmail: _o, ...rest }: StoredAllocation): Allocation => rest;

/**
 * Move money from the user's own wallet into a pouch. The pouch is owned by the backend owner key, so the
 * user's wallet pays the owner's token account and the backend then tops the pouch up from it.
 */
export function allocationRoutes(deps: Deps) {
  const app = new Hono<AuthEnv>();
  let rpc: AllocationChain | undefined;
  const chain = (): AllocationChain => {
    if (deps.allocationChain) return deps.allocationChain;
    if (process.env.VAULT_MODE !== "chain") throw new HttpError(503, "Wallet transfers need chain mode");
    return (rpc ??= createRpcAllocationChain());
  };
  const owned = async (id: string, email: string) => {
    const a = await deps.store.getAllocation(id);
    if (!a || a.ownerEmail !== email) throw new HttpError(404, "Allocation not found");
    return a;
  };

  app.post("/prepare", async (c) => {
    const b = prepareBody.parse(await c.req.json());
    const email = c.get("user").email;
    const transfers = chain();
    await getOwnedPouch(deps, b.pouchId, email);
    const wallet = (await deps.store.getUser(email))?.wallet;
    if (!wallet) throw new HttpError(400, "Link a wallet first", "WalletRequired");
    const id = randomUUID();
    const built = await transfers.buildTransfer({ wallet, amount: b.amount, allocationId: id });
    await deps.store.saveAllocation({ id, ownerEmail: email, pouchId: b.pouchId, amount: b.amount, wallet, status: "prepared", createdAt: new Date().toISOString() });
    return c.json({ allocationId: id, transaction: built.transaction, lastValidBlockHeight: built.lastValidBlockHeight }, 201);
  });

  app.post("/:id/complete", async (c) => {
    const { signature } = completeBody.parse(await c.req.json());
    const email = c.get("user").email;
    const transfers = chain();
    const initial = await owned(c.req.param("id"), email);
    if (initial.status === "completed") return c.json(publicAllocation(initial));
    return deps.store.withPouchLock(initial.pouchId, async () => {
      let a = await owned(initial.id, email);
      if (a.status === "completed") return c.json(publicAllocation(a));
      if (a.txSignature && a.txSignature !== signature) throw new HttpError(422, "This allocation is already bound to a different transaction");
      const used = await deps.store.findAllocationByTxSignature(signature);
      if (used && used.id !== a.id) throw new HttpError(422, "This transaction was already used for another allocation");
      const check = await transfers.verifyTransfer({ signature, wallet: a.wallet, amount: a.amount, allocationId: a.id });
      if (!check.ok) throw new HttpError(422, `Transfer could not be verified: ${check.reason}`, "TransferNotVerified");
      try {
        // Reserve the signature before crediting so a retry or a second allocation cannot reuse it.
        a = await deps.store.saveAllocation({ ...a, txSignature: signature });
      } catch (e) {
        if (e instanceof StoreConflictError) throw new HttpError(422, "This transaction was already used for another allocation");
        throw e;
      }
      const { txSignature } = await deps.vault.topUp(a.pouchId, a.amount, a.id);
      const done = await deps.store.saveAllocation({ ...a, status: "completed", topUpSignature: txSignature, completedAt: new Date().toISOString() });
      return c.json(publicAllocation(done));
    });
  });

  return app;
}
