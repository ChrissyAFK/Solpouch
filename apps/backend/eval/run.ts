// Run by hand; it calls the real APIs and costs a few cents per request:
//   npx tsx eval/run.ts [--only fast_food] [--limit 10] [--parallel 4]
import { config } from "dotenv";
import { readFileSync } from "node:fs";
config({ path: process.env.EVAL_ENV ?? "../../.env" });
const { understand } = await import("../src/ai/understand.js");
const { findCart } = await import("../src/ai/findCart.js");
const { parseRequestConstraints } = await import("../src/services/request-constraints.js");
const { storeMatches } = await import("../src/ai/storeMatch.js");

const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
let cases: any[] = JSON.parse(readFileSync(new URL("./requests.json", import.meta.url), "utf8"));
if (arg("--only")) cases = cases.filter((c) => c.category === arg("--only"));
if (arg("--limit")) cases = cases.slice(0, Number(arg("--limit")));

async function one(c: any) {
  const t0 = Date.now();
  const row: any = { text: c.text.slice(0, 44), cat: c.category, ok: false };
  try {
    const u = await understand(c.text);
    if (u.clarify) {
      row.result = `ASK: ${u.clarify.question}`.slice(0, 60);
      row.ok = c.expect?.clarify === true;
    } else {
      const { maxPrice, perItem } = parseRequestConstraints(c.text);
      const cap = maxPrice !== undefined ? maxPrice / 1_000_000 : undefined;
      const choose = !u.items.length && !!u.store && cap !== undefined;
      const f = await findCart(u.items, { store: u.store, service: u.service, ...(choose ? { chooseItems: true } : {}), ...(cap !== undefined ? (perItem ? { maxPerItem: cap } : { maxTotal: cap }) : {}) });
      if (!f) row.result = "NOT FOUND";
      else {
        const total = f.items.reduce((s, i) => s + i.unitPrice * (u.items.find((x) => x.requested === i.requested)?.qty ?? 1), 0);
        row.result = `${f.store.name} (${f.store.domain})`.slice(0, 40);
        row.items = `${f.items.length}/${choose ? f.items.length : u.items.length}`;
        row.verified = `${f.items.filter((i) => i.verified).length}/${f.items.length}`;
        row.total = total.toFixed(2);
        row.ok = c.expect?.clarify !== true && (!c.expect?.store || storeMatches(c.expect.store, f.store.name, f.store.domain)) &&
          (c.expect?.maxTotal === undefined || total <= c.expect.maxTotal) && f.items.length >= (choose ? 1 : u.items.length);
      }
    }
  } catch (e: any) {
    row.result = `ERROR ${e?.name}: ${e?.message}`.slice(0, 60);
  }
  row.s = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${row.ok ? "PASS" : "FAIL"} ${row.s}s  ${row.text}  ->  ${row.result}  ${row.verified ? `items ${row.items} verified ${row.verified} total ${row.total}` : ""}`);
  return row;
}

const rows: any[] = [];
const queue = [...cases];
await Promise.all(Array.from({ length: Number(arg("--parallel") ?? 1) }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) rows.push(await one(c));
}));
const secs = rows.map((r) => Number(r.s)).sort((a, b) => a - b);
const v = rows.filter((r) => r.verified).map((r) => r.verified.split("/").map(Number));
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed · median ${secs[Math.floor(secs.length / 2)]}s · slowest ${secs[secs.length - 1]}s · prices verified ${v.reduce((s, x) => s + x[0], 0)}/${v.reduce((s, x) => s + x[1], 0)}`);
