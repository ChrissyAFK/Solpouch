import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.js");
const { MemoryStore } = await import("./store/memory.js");
const { createVaultClient } = await import("./vault/index.js");

// TODO: use a PostgresStore (Tiger Data) when DATABASE_URL is set.
const store = new MemoryStore();
const vault = createVaultClient(store);
const app = createApp({ store, vault });

const port = Number(process.env.BACKEND_PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`solpouch backend on :${port} (vault=${process.env.VAULT_MODE ?? "mock"}, gemini=${process.env.GEMINI_API_KEY ? "on" : "offline fallback"})`);
});
