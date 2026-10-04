import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");
const { MemoryStore } = await import("./store/memory.js");
const { createVaultClient } = await import("./vault/index.js");

const { PostgresStore } = await import("./store/postgres.js");
const store = process.env.DATABASE_URL ? await PostgresStore.connect(process.env.DATABASE_URL, []) : new MemoryStore([],process.env.LEGACY_OWNER_EMAIL?.trim().toLowerCase());
console.log(`store: ${process.env.DATABASE_URL ? "postgres (Tiger Data)" : "memory"}`);
let vault = createVaultClient(store);
if (process.env.VAULT_MODE === "chain") {
  const { ensureOnChain, ChainVaultClient } = await import("./vault/index.js");
  const { SyncedVaultClient } = await import("./vault/synced.js");
  // Creates missing pouches on devnet and funds each vault up to its stored balance.
  for (const p of await ensureOnChain(vault as InstanceType<typeof ChainVaultClient>, await store.listPouches())) {
    await store.savePouch(p);
  }
  vault = new SyncedVaultClient(vault, store);
  for (const p of await store.listPouches()) {
    const { balance, spentToday } = await vault.getBalance(p.id);
    await store.savePouch({ ...p, balance, spentToday });
  }
}
const app = createApp({ store, vault });

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, gemini=${process.env.GEMINI_API_KEY ? "on" : "offline fallback"})`);
});
