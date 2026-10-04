import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");
const { MemoryStore } = await import("./store/memory.js");
const { createVaultClient } = await import("./vault/index.js");
const { aiProvider } = await import("./ai/provider.js");

const { PostgresStore } = await import("./store/postgres.js");
const store = process.env.DATABASE_URL ? await PostgresStore.connect(process.env.DATABASE_URL, []) : new MemoryStore([],process.env.LEGACY_OWNER_EMAIL?.trim().toLowerCase());
console.log(`store: ${process.env.DATABASE_URL ? "postgres (Tiger Data)" : "memory"}`);
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
const app = createApp({ store, vault });

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
  process.once(signal, () => { void (indexer?.stop() ?? Promise.resolve()).finally(() => process.exit(0)); });
}

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, ai=${aiProvider()})`);
});
