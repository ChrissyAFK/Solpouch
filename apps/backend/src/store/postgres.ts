import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Order, OrderLine, Pouch, TopUp } from "@solpouch/shared";
import { seedPouches } from "./memory.js";
import type { Store } from "./types.js";

const today = () => localDay(new Date());
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/* eslint-disable @typescript-eslint/no-explicit-any */
function toPouch(r: any): Pouch {
  const fresh = r.spent_day instanceof Date && localDay(r.spent_day) === today();
  return {
    id: r.id,
    address: r.address,
    name: r.name,
    balance: Number(r.balance),
    maxPerOrder: Number(r.max_per_order),
    dailyLimit: Number(r.daily_limit),
    spentToday: fresh ? Number(r.spent_today) : 0,
    confirmAbove: Number(r.confirm_above),
    allowedMerchantIds: r.allowed_merchant_ids,
    frozen: r.frozen,
  };
}
// pg parses `date` into a local-midnight Date; format it in local time.
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function toOrder(r: any): Order {
  const o: Order = {
    id: r.id,
    pouchId: r.pouch_id,
    merchantId: r.merchant_id,
    request: r.request,
    lines: r.lines as OrderLine[],
    total: Number(r.total),
    status: r.status,
    createdAt: iso(r.created_at),
  };
  if (r.reject_reason) o.rejectReason = r.reject_reason;
  if (r.tx_signature) o.txSignature = r.tx_signature;
  return o;
}
function toTopUp(r: any): TopUp {
  return {
    id: r.id,
    pouchId: r.pouch_id,
    amount: Number(r.amount),
    reason: r.reason,
    status: r.status,
    readyAt: iso(r.ready_at),
    createdAt: iso(r.created_at),
  };
}

export class PostgresStore implements Store {
  private constructor(private pool: pg.Pool) {}

  static async connect(url: string, seed: Pouch[] = seedPouches()): Promise<PostgresStore> {
    // pg treats sslmode=require as verify-full and ignores our ssl option; strip it.
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    const pool = new pg.Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, max: 5 });
    // pg returns date as local Date by default; keep that (handled in toPouch).
    const sql = readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8");
    await pool.query(sql);
    const store = new PostgresStore(pool);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pouches");
    if (rows[0].n === 0) for (const p of seed) await store.savePouch(p);
    return store;
  }

  async close() {
    await this.pool.end();
  }

  async listPouches() {
    const { rows } = await this.pool.query("SELECT * FROM pouches ORDER BY created_at, id");
    return rows.map(toPouch);
  }
  async getPouch(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM pouches WHERE id = $1", [id]);
    return rows[0] ? toPouch(rows[0]) : undefined;
  }
  async savePouch(p: Pouch) {
    await this.pool.query(
      `INSERT INTO pouches (id, address, name, balance, max_per_order, daily_limit, spent_today, spent_day,
         confirm_above, allowed_merchant_ids, frozen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET address=$2, name=$3, balance=$4, max_per_order=$5, daily_limit=$6,
         spent_today=$7, spent_day=$8::date, confirm_above=$9, allowed_merchant_ids=$10, frozen=$11`,
      [p.id, p.address, p.name, p.balance, p.maxPerOrder, p.dailyLimit, p.spentToday, localDay(new Date()),
       p.confirmAbove, p.allowedMerchantIds, p.frozen],
    );
    return p;
  }

  async listOrders(pouchId?: string) {
    const { rows } = pouchId
      ? await this.pool.query("SELECT * FROM orders WHERE pouch_id = $1 ORDER BY created_at DESC", [pouchId])
      : await this.pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    return rows.map(toOrder);
  }
  async getOrder(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM orders WHERE id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
    return rows[0] ? toOrder(rows[0]) : undefined;
  }
  async saveOrder(o: Order) {
    await this.pool.query(
      `INSERT INTO orders (id, created_at, pouch_id, merchant_id, request, lines, total, status, reject_reason, tx_signature)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT (id, created_at) DO UPDATE SET pouch_id=$3, merchant_id=$4, request=$5, lines=$6::jsonb,
         total=$7, status=$8, reject_reason=$9, tx_signature=$10`,
      [o.id, o.createdAt, o.pouchId, o.merchantId, o.request, JSON.stringify(o.lines), o.total, o.status,
       o.rejectReason ?? null, o.txSignature ?? null],
    );
    return o;
  }

  async getTopUp(id: string) {
    const { rows } = await this.pool.query("SELECT * FROM topups WHERE id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
    return rows[0] ? toTopUp(rows[0]) : undefined;
  }
  async saveTopUp(t: TopUp) {
    await this.pool.query(
      `INSERT INTO topups (id, created_at, pouch_id, amount, reason, status, ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id, created_at) DO UPDATE SET pouch_id=$3, amount=$4, reason=$5, status=$6, ready_at=$7`,
      [t.id, t.createdAt, t.pouchId, t.amount, t.reason, t.status, t.readyAt],
    );
    return t;
  }
}
