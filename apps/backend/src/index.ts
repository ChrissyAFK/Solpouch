import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");
const { MemoryStore } = await import("./store/memory.js");
const { createVaultClient } = await import("./vault/index.js");
const { aiProvider } = await import("./ai/provider.js");

const { PostgresStore, postgresPoolConfig } = await import("./store/postgres.js");
if (process.env.VAULT_MODE === "chain" && !process.env.DATABASE_URL) {
  throw new Error("Chain mode requires DATABASE_URL so payment recovery survives restarts");
}
if (process.env.DATABASE_URL && process.env.VAULT_MODE !== "chain") {
  throw new Error("Mock mode uses temporary memory only. Clear DATABASE_URL for the mock demo, or configure chain mode for persistent payments.");
}
const store = process.env.DATABASE_URL ? await PostgresStore.connect(process.env.DATABASE_URL, []) : new MemoryStore([], process.env.LEGACY_OWNER_EMAIL?.trim().toLowerCase());
console.log(`store: ${process.env.DATABASE_URL ? "postgres (Tiger Data)" : "memory"}`);
if (process.env.VAULT_MODE === "chain") {
  const { assertCheckoutPayTo } = await import("./services/fulfillment.js");
  // Not fatal: the API still serves everything else, but any-store and web-store orders can't settle until this is set.
  try { assertCheckoutPayTo(); } catch (err) { console.warn(`WARNING: ${(err as Error).message} Any-store and web-store orders will be rejected until it is set.`); }
}
let vault = createVaultClient(store);
if (process.env.VAULT_MODE === "chain") {
  const { SyncedVaultClient } = await import("./vault/synced.js");


  vault = new SyncedVaultClient(vault, store);
  for (const p of await store.listPouches()) {
    await store.withPouchLock(p.id,async()=> {
      const fresh=(await store.getPouch(p.id))!;
      const state = vault.getState ? await vault.getState(p.id) : await vault.getBalance(p.id);
      await store.savePouch({ ...fresh, ...state });
    });
  }

}
let fundingRepository = store instanceof PostgresStore ? await store.fundingRepository() : undefined;
// Sandbox bank requests can be durable without persisting simulated pouch balances.
if (!fundingRepository && process.env.FUNDING_DATABASE_URL) {
  const { default: pg } = await import("pg");
  const { PostgresFundingRepository } = await import("./funding/repository.js");
  const fundingPool = new pg.Pool(postgresPoolConfig(process.env.FUNDING_DATABASE_URL));
  fundingPool.on("error", () => console.warn("Funding database connection closed; the pool will replace it."));
  try {
    const repository = new PostgresFundingRepository(fundingPool);
    await repository.initialize();
    fundingRepository = repository;
  } catch (error) {
    await fundingPool.end();
    throw error;
  }
}
const app = createApp({ store, vault, fundingRepository });

// Pays withdrawals whose hold is over. Uses the base store (system access), never a user-scoped one.
const { payDueWithdrawals } = await import("./services/withdrawals.js");
setInterval(() => void payDueWithdrawals({ store, vault }), 60_000).unref?.();
setTimeout(() => void payDueWithdrawals({ store, vault }), 5_000).unref?.();

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, ai=${aiProvider()})`);
});
