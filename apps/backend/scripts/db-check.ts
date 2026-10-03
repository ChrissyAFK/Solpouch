import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const { PostgresStore } = await import("../src/store/postgres.js");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const store = await PostgresStore.connect(url);
console.log("pouches:", (await store.listPouches()).length, "orders:", (await store.listOrders()).length);
await store.close();
