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
  assertCheckoutPayTo();
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
}
const app = createApp({ store, vault });

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, ai=${aiProvider()})`);
});
