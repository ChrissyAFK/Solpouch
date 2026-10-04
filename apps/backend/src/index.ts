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


  try {
    const chain = vault as { checkAgentBalance?: () => Promise<number> };
    await chain.checkAgentBalance?.();
  } catch (e) { console.warn(`[startup] Could not read the agent SOL balance: ${e instanceof Error ? e.message : e}`); }
  vault = new SyncedVaultClient(vault, store);
  for (const p of await store.listPouches()) {
    try {
      await store.withPouchLock(p.id,async()=> {
        const fresh=(await store.getPouch(p.id))!;
        const read = () => vault.getState ? vault.getState(p.id) : vault.getBalance(p.id);
        let state;
        try { state = await read(); } catch (err) {
          if (!/differ from the chain/.test((err as Error).message)) throw err;
          // Pushing stored rules on chain without review is opt-in: a wrong payTo in config would otherwise be allowlisted for every pouch.
          if (process.env.RESYNC_RULES_ON_START !== "1") throw err;
          // Same owner-signed setRules call the rules PATCH route uses: push the stored rules (with current checkout key) on chain.
          await vault.updateRules(fresh);
          console.warn(`startup sync: re-synced on-chain allowlist for pouch ${p.id}`);
          state = await read();
        }
        await store.savePouch({ ...fresh, ...state });
      });
    } catch (err) {
      console.warn(`startup sync: skipping pouch ${p.id}: ${(err as Error).message}`);
    }
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
// Stripe demo storage is separate from Transak and never uses an in-memory server repository.
// A bad Stripe setting must not take the rest of the API offline.
let stripeRepository: import("./stripe/repository.js").PostgresStripeRepository | undefined;
let stripePool: import("pg").Pool | undefined;
const stripeDatabase = process.env.FUNDING_DATABASE_URL || process.env.DATABASE_URL;
if (stripeDatabase && (process.env.FUNDING_PROVIDER === "stripe" || process.env.STRIPE_SECRET_KEY)) {
  const { default: pg } = await import("pg");
  const { PostgresStripeRepository } = await import("./stripe/repository.js");
  try {
    stripePool = new pg.Pool({ ...postgresPoolConfig(stripeDatabase), max: 5, connectionTimeoutMillis: 3000 });
    stripePool.on("error", () => console.warn("Stripe funding database connection closed."));
    const repository = new PostgresStripeRepository(stripePool);
    await repository.initialize();
    stripeRepository = repository;
  } catch {
    await stripePool?.end().catch(() => {});
    stripePool = undefined;
    console.warn("Stripe funding storage is unavailable; card checkout is disabled.");
  }
}
const { createDevnetMint } = await import("./stripe/mint.js");
const app = createApp({ store, vault, fundingRepository, stripeRepository, stripeMint: createDevnetMint() });

// Pays withdrawals whose hold is over. Uses the base store (system access), never a user-scoped one.
const { payDueWithdrawals } = await import("./services/withdrawals.js");
setInterval(() => void payDueWithdrawals({ store, vault }), 60_000).unref?.();
setTimeout(() => void payDueWithdrawals({ store, vault }), 5_000).unref?.();

// Read-only chain indexer (off unless ENABLE_INDEXER=true, VAULT_MODE=chain and Postgres).
const { indexerDisabledReason, VaultIndexer } = await import("./indexer.js");
const indexerOff = indexerDisabledReason(process.env, store instanceof PostgresStore);
let indexer: InstanceType<typeof VaultIndexer> | undefined;
if (!indexerOff && store instanceof PostgresStore) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  indexer = new VaultIndexer({
    connection: new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed"),
    programId: new PublicKey(process.env.VAULT_PROGRAM_ID!),
    store,
    pollMs: Number(process.env.INDEXER_POLL_MS) || 30_000,
  });
  void indexer.start().then(() => console.log("indexer: started"));
} else if (process.env.ENABLE_INDEXER === "true") {
  console.warn(`indexer: not started (${indexerOff})`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void Promise.allSettled([indexer?.stop() ?? Promise.resolve(), stripePool?.end() ?? Promise.resolve()]).finally(() => process.exit(0)); });
}

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, ai=${aiProvider()})`);
});
