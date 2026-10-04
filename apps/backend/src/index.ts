import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");
const { MemoryStore } = await import("./store/memory.js");
const { createVaultClient } = await import("./vault/index.js");
const { aiProvider } = await import("./ai/provider.js");

const { PostgresStore } = await import("./store/postgres.js");
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
  const { ensureOnChain, ChainVaultClient } = await import("./vault/index.js");
  const { SyncedVaultClient } = await import("./vault/synced.js");
  // Only reads existing chain accounts. Startup never creates, mints or transfers funds.
  const chainVault = vault as InstanceType<typeof ChainVaultClient>;
  for (const p of await ensureOnChain(chainVault, await store.listPouches())) {
    await store.savePouch(p);
  }
  await chainVault.checkAgentBalance().catch((e) => console.warn(`[startup] Could not read the agent SOL balance: ${e instanceof Error ? e.message : e}`));
  vault = new SyncedVaultClient(vault, store);

  // Feeds the Tiger Data payments table: backfills paid orders, then follows the program's PaymentMade events.
  // Read-only on chain, and it must never hold up or take down the API, so it is not awaited.
  const { startIndexer } = await import("./indexer.js");
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { default: idlJson } = await import("./vault/idl/solpouch_vault.json", { with: { type: "json" } });
  void startIndexer({
    store,
    connection: new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed"),
    programId: new PublicKey(process.env.VAULT_PROGRAM_ID ?? ""),
    idl: idlJson as unknown as import("@coral-xyz/anchor").Idl,
  }).catch((e) => console.warn(`[indexer] not started: ${e instanceof Error ? e.message : e}`));
}
const app = createApp({ store, vault });

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, ai=${aiProvider()})`);
});
