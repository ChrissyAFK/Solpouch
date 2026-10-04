import { PostgresFundingRepository } from "../funding/repository.js";
import { HttpError } from "../services/orders.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Order, Pouch, SpendPoint, TopUp, Withdrawal } from "@solpouch/shared";
import { StoreConflictError, WalletAlreadyLinkedError, spendWindowStart, windowedSpend, sameOperation, validateRateLimit, type Store, type VaultOperation, type AuthSession, type AuthChallenge, type StoredShoppingList, type StoredAllocation, type StoredPouch, type UserProfile, type UserPatch, type PaymentIndex, type VaultEventRecord, type PaymentRecord, type PriceRecord, type IndexerCursor } from "./types.js";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
type Row = Record<string, any>;
function toShoppingList(r: Row): StoredShoppingList { return { id:r.id, ownerEmail:r.owner_email, version:Number(r.version), name:r.name, items:structuredClone(r.items), createdAt:iso(r.created_at), updatedAt:iso(r.updated_at) }; }
function toPouch(r: Row): StoredPouch {
  return { id: r.id, address: r.address, name: r.name, balance: Number(r.balance), maxPerOrder: Number(r.max_per_order), dailyLimit: Number(r.daily_limit), spentToday: windowedSpend(Number(r.spent_today),r.spent_since ? iso(r.spent_since) : undefined), ...(r.spent_since && windowedSpend(1,iso(r.spent_since)) ? {spentSince:iso(r.spent_since)} : {}), confirmAbove: Number(r.confirm_above), allowedMerchantIds: structuredClone(r.allowed_merchant_ids), frozen: r.frozen, version: Number(r.version), ...(r.owner_email ? { ownerEmail: r.owner_email } : {}) };
}
function toOrder(r: Row): Order {
  return { id: r.id, pouchId: r.pouch_id, merchantId: r.merchant_id, request: r.request, lines: structuredClone(r.lines), total: Number(r.total), status: r.status, createdAt: iso(r.created_at), version: Number(r.version), ...(r.reject_reason ? { rejectReason: r.reject_reason } : {}), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}), ...(r.store ? {store:r.store}:{}), ...(r.fulfillment ? {fulfillment:r.fulfillment}:{}), ...(r.paid_at ? {paidAt:iso(r.paid_at)}:{}) };
}
function toTopUp(r: Row): TopUp {
  return { id: r.id, pouchId: r.pouch_id, amount: Number(r.amount), reason: r.reason, status: r.status, ...(r.fail_reason ? {failReason:r.fail_reason}:{}), ...(r.completed_at ? {completedAt:iso(r.completed_at)}:{}), ...(r.from_wallet ? { fromWallet: r.from_wallet } : {}), readyAt: iso(r.ready_at), createdAt: iso(r.created_at), version: Number(r.version), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}) };
}
function toAllocation(r: Row): StoredAllocation {
  return { id: r.id, ownerEmail: r.owner_email, pouchId: r.pouch_id, amount: Number(r.amount), wallet: r.wallet, status: r.status, createdAt: iso(r.created_at), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}), ...(r.top_up_signature ? { topUpSignature: r.top_up_signature } : {}), ...(r.completed_at ? { completedAt: iso(r.completed_at) } : {}) };
}
function toWithdrawal(r: Row): Withdrawal {
  return { id: r.id, pouchId: r.pouch_id, amount: Number(r.amount), reason: r.reason, toWallet: r.to_wallet, status: r.status, readyAt: iso(r.ready_at), createdAt: iso(r.created_at), version: Number(r.version), ...(r.fail_reason ? { failReason: r.fail_reason } : {}), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}) };
}
function toOperation(r: Row): VaultOperation {
  return { id: r.id, kind: r.kind, pouchId: r.pouch_id, txSignature: r.tx_signature, signedTransaction: r.signed_transaction, lastValidBlockHeight: Number(r.last_valid_block_height), createdAt: iso(r.created_at) };
}

function toUser(r: Row): UserProfile {
  const u: UserProfile = { email: r.email, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
  if (r.display_name) u.displayName = r.display_name;
  if (r.avatar) u.avatar = r.avatar;
  if (r.wallet) u.wallet = r.wallet;
  return u;
}

export function postgresPoolConfig(url: string): pg.PoolConfig {
  const u = new URL(url);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || !u.hostname) throw new Error("Invalid database URL");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
  const disable = u.searchParams.get("sslmode") === "disable" || (local && process.env.DB_ALLOW_INSECURE_LOCAL === "true");
  if (disable && !local) throw new Error("Unencrypted database connections are allowed only on localhost");
  // pg connection-string SSL parameters override the explicit ssl object; remove them.
  for (const key of ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"]) u.searchParams.delete(key);
  return { connectionString: u.toString(), max: 5, connectionTimeoutMillis: 10_000, ssl: disable ? false : { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT ? { ca: readFileSync(process.env.DATABASE_CA_CERT, "utf8") } : {}) } };
}

const LOCK_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class PostgresStore implements Store, PaymentIndex {
  readonly persistentLists = true;
  private context = new AsyncLocalStorage<{ client: pg.PoolClient; locks: Set<string>; state: { error?: Error } }>();
  private nextCleanupAt = 0;
  private async cleanupExpired() {
    const now = Date.now();
    if (now < this.nextCleanupAt) return;
    this.nextCleanupAt = now + 60_000;
    // Limit each sweep so cleanup cannot monopolize a request or lock large tables.
    for (const [table, key] of [["web_sessions", "id"], ["auth_challenges", "id"], ["rate_limit_buckets", "key"]]) {
      await this.query(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE expires_at <= now() ORDER BY expires_at LIMIT 1000) AND expires_at <= now()`);
    }
  }
  private constructor(private pool: pg.Pool) {
    // pg emits errors on idle clients via Pool, outside any query promise.
    pool.on("error", () => { console.warn("Database connection closed unexpectedly; the pool will replace it."); });
  }
  private async query(sql: string, values?: unknown[]) {
    const held = this.context.getStore();
    if (held?.state.error) throw held.state.error;
    return (held?.client ?? this.pool).query(sql, values);
  }

  static async connect(url: string, seed: StoredPouch[] = []): Promise<PostgresStore> {
    const pool = new pg.Pool(postgresPoolConfig(url));
    const store = new PostgresStore(pool);
    try {
      await pool.query(readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8"));
      if (seed.length) await store.lock("seed", async () => {
        const { rows } = await store.query("SELECT count(*)::int AS n FROM pouches");
        if (rows[0].n === 0) for (const p of seed) await store.savePouch({ ...p, version: undefined });
      });
      const legacy = process.env.LEGACY_OWNER_EMAIL?.trim().toLowerCase();
      if (legacy) await store.query("UPDATE pouches SET owner_email=$1 WHERE owner_email IS NULL", [legacy]);
      return store;
    } catch (error) { await pool.end(); throw error; }
  }
  async fundingRepository() {
    const repository = new PostgresFundingRepository(this.pool);
    await repository.initialize();
    return repository;
  }
  async close() { await this.pool.end(); }

  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const held = this.context.getStore();
    if (held?.state.error) throw held.state.error;
    if (held?.locks.has(key)) return fn();
    const client = held?.client ?? await this.pool.connect();
    // Nested locks share this failure flag so none can continue using a lost lock.
    const state = held?.state ?? {} as { error?: Error };
    const onError = () => { state.error ??= new Error("Database connection lost while holding an operation lock"); };
    if (!held) client.on("error", onError);
    let acquired = false;
    try {
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
        if (rows[0]?.ok) { acquired = true; break; }
        if (Date.now() >= deadline) throw new HttpError(409, "Pouch is busy, try again");
        await sleep(50);
      }

      if (state.error) throw state.error;
      const result = await this.context.run({ client, locks: new Set([...(held?.locks ?? []), key]), state }, fn);
      if (state.error) throw state.error;
      return result;
    } finally {
      try {
        if (acquired && !state.error) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch (error) {
        state.error ??= new Error("Database operation lock could not be released");
        throw error;
      } finally {
        if (!held) {
          // Destroy failed clients; never put a connection with unknown lock state back in the pool.
          client.release(!!state.error || !acquired);
          client.removeListener("error", onError);
        }
      }
    }
  }
  withPouchLock<T>(id: string, fn: () => Promise<T>) { return this.lock(`pouch:${id}`, fn); }

  private async save(table: "pouches" | "orders" | "topups" | "withdrawals" | "shopping_lists", record: { id: string; version?: number; createdAt?: string }, fields: Record<string, unknown>): Promise<Row> {
    // Timescale's primary keys include created_at. Serialize by logical ID so a
    // changed timestamp cannot create a second object with the same public ID.
    return this.lock(`record:${table}:${record.id}`, async () => {
      const { rows: current } = await this.query(`SELECT * FROM ${table} WHERE id=$1`, [record.id]);
      if (current.length > 1) throw new StoreConflictError("Duplicate legacy record requires reconciliation");
      const row = current[0];
      if (row ? record.version !== Number(row.version) : record.version !== undefined) throw new StoreConflictError();
      if (row && record.createdAt && iso(row.created_at) !== iso(record.createdAt)) throw new StoreConflictError("Creation time cannot change");
      if (row && table === "shopping_lists" && row.owner_email !== fields.owner_email) throw new StoreConflictError();
      const columns = Object.keys(fields);
      const values = Object.values(fields);
      if (!row) {
        try {
          const { rows } = await this.query(`INSERT INTO ${table} (id, ${columns.join(", ")}, version) VALUES ($1, ${values.map((_, i) => `$${i + 2}`).join(", ")}, 1) RETURNING *`, [record.id, ...values]);
          return rows[0];
        } catch (error) {
          if ((error as { code?: string }).code === "23505") throw new StoreConflictError();
          throw error;
        }
      }
      const { rows } = await this.query(`UPDATE ${table} SET ${columns.map((c, i) => `${c}=$${i + 2}`).join(", ")}, version=version+1 WHERE id=$1 AND version=$${values.length + 2} RETURNING *`, [record.id, ...values, record.version]);
      if (rows.length !== 1) throw new StoreConflictError();
      return rows[0];
    });
  }

  async listShoppingLists(ownerEmail: string) { return (await this.query("SELECT * FROM shopping_lists WHERE owner_email=$1 ORDER BY updated_at DESC",[ownerEmail])).rows.map(toShoppingList); }
  async getShoppingList(id: string) { const {rows} = await this.query("SELECT * FROM shopping_lists WHERE id=$1",[id]); return rows[0] ? toShoppingList(rows[0]) : undefined; }
  async saveShoppingList(list: StoredShoppingList) { return toShoppingList(await this.save("shopping_lists",list,{owner_email:list.ownerEmail,name:list.name,items:JSON.stringify(list.items),created_at:list.createdAt,updated_at:list.updatedAt})); }
  async deleteShoppingList(id: string, ownerEmail: string, version: number) {
    const result = await this.query("DELETE FROM shopping_lists WHERE id=$1 AND owner_email=$2 AND version=$3",[id,ownerEmail,version]);
    if (result.rowCount !== 1) throw new StoreConflictError();
  }
  async listPouches(ownerEmail?: string) { return (await this.query(`SELECT * FROM pouches ${ownerEmail ? "WHERE owner_email=$1 " : ""}ORDER BY created_at, id`, ownerEmail ? [ownerEmail] : undefined)).rows.map(toPouch); }
  async getPouch(id: string) { const { rows } = await this.query("SELECT * FROM pouches WHERE id=$1", [id]); return rows[0] ? toPouch(rows[0]) : undefined; }
  async savePouch(p: StoredPouch) {
    return toPouch(await this.save("pouches", p, { address: p.address, name: p.name, balance: p.balance, max_per_order: p.maxPerOrder, daily_limit: p.dailyLimit, spent_today: p.spentToday, spent_since: spendWindowStart(p) ?? null, confirm_above: p.confirmAbove, allowed_merchant_ids: p.allowedMerchantIds, frozen: p.frozen, owner_email: p.ownerEmail ?? null }));
  }
  async listOrders(pouchId?: string) { return (await this.query(`SELECT * FROM orders ${pouchId ? "WHERE pouch_id=$1 " : ""}ORDER BY created_at DESC`, pouchId ? [pouchId] : undefined)).rows.map(toOrder); }
  async recordPayment(p: PaymentRecord) {
    return this.lock(`payment:${p.txSignature}`, async () => {
    await this.insertPayment(p);
    });
  }
  /** The primary key includes time, and the app and the indexer stamp different times, so dedupe on (tx_signature, order_id). */
  private async insertPayment(p: PaymentRecord) {
    await this.query(
      "INSERT INTO payments (time, pouch_id, merchant_id, order_id, amount, tx_signature) SELECT $1, $2, $3, $4, $5, $6 WHERE NOT EXISTS (SELECT 1 FROM payments WHERE tx_signature = $6 AND lower(order_id) = lower($4)) ON CONFLICT DO NOTHING",
      [p.time, p.pouchId, p.merchantId, p.orderId, p.amount, p.txSignature],
    );
  }
  async recordPrices(rows: PriceRecord[]) {
    for (const r of rows) await this.query("INSERT INTO prices (time, merchant_id, product_id, unit_price, in_stock) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [r.time, r.merchantId, r.productId, r.unitPrice, r.inStock]);
  }
  async spendSeries(pouchIds: string[], bucket: "hour" | "day", since: string): Promise<SpendPoint[]> {
    if (!pouchIds.length) return [];
    const { rows } = await this.query(
      `SELECT time_bucket($1::interval, time) AS bucket, pouch_id, sum(amount)::bigint AS spent, count(*)::int AS orders FROM payments WHERE pouch_id = ANY($2::text[]) AND time >= $3 GROUP BY 1, 2 ORDER BY 1, 2`,
      [bucket === "day" ? "1 day" : "1 hour", pouchIds, since],
    );
    return rows.map((r: Row) => ({ bucket: iso(r.bucket), pouchId: r.pouch_id, spent: Number(r.spent), orders: Number(r.orders) }));
  }
  async getOrder(id: string) { const { rows } = await this.query("SELECT * FROM orders WHERE id=$1 ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? toOrder(rows[0]) : undefined; }
  async saveOrder(o: Order) { return toOrder(await this.save("orders", o, { created_at: o.createdAt, pouch_id: o.pouchId, merchant_id: o.merchantId, request: o.request, lines: JSON.stringify(o.lines), total: o.total, status: o.status, reject_reason: o.rejectReason ?? null, tx_signature: o.txSignature ?? null, store: o.store ? JSON.stringify(o.store) : null, fulfillment: o.fulfillment ? JSON.stringify(o.fulfillment) : null, paid_at: o.paidAt ?? null })); }
  async getTopUp(id: string) { const { rows } = await this.query("SELECT * FROM topups WHERE id=$1 ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? toTopUp(rows[0]) : undefined; }
  async saveTopUp(t: TopUp) { return toTopUp(await this.save("topups", t, { created_at: t.createdAt, pouch_id: t.pouchId, amount: t.amount, reason: t.reason, status: t.status, ready_at: t.readyAt, tx_signature: t.txSignature ?? null, fail_reason: t.failReason ?? null, completed_at: t.completedAt ?? null, from_wallet: t.fromWallet ?? null })); }

  async applyMockOperation(pouch: StoredPouch, operation: VaultOperation) {
    await this.withPouchLock(pouch.id,async()=> {
      await this.query("BEGIN");
      try {
        if(await this.getOperation(operation.id)) throw new StoreConflictError("Operation already applied");
        await this.savePouch(pouch);
        await this.saveOperation(operation);
        await this.query("COMMIT");
      } catch(error) {
        await this.query("ROLLBACK").catch(()=>{});
        throw error;
      }
    });
  }
  async getOperation(id: string) { const { rows } = await this.query("SELECT * FROM vault_operations WHERE id=$1", [id]); return rows[0] ? toOperation(rows[0]) : undefined; }
  async saveOperation(record: VaultOperation) {
    await this.query("INSERT INTO vault_operations (id,kind,pouch_id,tx_signature,signed_transaction,last_valid_block_height,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING", [record.id, record.kind, record.pouchId, record.txSignature, record.signedTransaction, record.lastValidBlockHeight, record.createdAt]);
    const current = await this.getOperation(record.id);
    if (!current || !sameOperation(current, { ...record, createdAt: iso(record.createdAt) })) throw new StoreConflictError("Operation is immutable");
  }
  async saveSession(s: AuthSession) {
    await this.cleanupExpired();
    const {rowCount} = await this.query("INSERT INTO web_sessions (id,email,name,picture,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",[s.id,s.email,s.name,s.picture,s.createdAt,s.expiresAt]);
    if (!rowCount) throw new StoreConflictError("Session already exists");
  }
  async getSession(id: string) {
    const {rows} = await this.query("SELECT * FROM web_sessions WHERE id=$1 AND expires_at > now()",[id]);
    const r=rows[0]; return r ? {id:r.id,email:r.email,name:r.name,picture:r.picture,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at)}:undefined;
  }
  async deleteSession(id: string) { await this.query("DELETE FROM web_sessions WHERE id=$1",[id]); }
  async listSessions(email: string): Promise<AuthSession[]> { return (await this.query("SELECT * FROM web_sessions WHERE email=$1 AND expires_at > now()",[email])).rows.map(r=>({id:r.id,email:r.email,name:r.name,picture:r.picture,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at)})); }
  async deleteSessions(email: string) { await this.query("DELETE FROM web_sessions WHERE email=$1",[email]); }
  async deleteAccount(email: string) {
    // payments/prices/vault_events mirror the public chain and hold no personal data: kept.
    await this.lock(`user:${email}`, async () => {
      await this.query("BEGIN");
      try {
        const mine = "SELECT id FROM pouches WHERE owner_email=$1";
        await this.query(`DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders WHERE pouch_id IN (${mine}))`, [email]);
        for (const t of ["orders", "topups", "withdrawals", "vault_operations"]) await this.query(`DELETE FROM ${t} WHERE pouch_id IN (${mine})`, [email]);
        await this.query("DELETE FROM pouches WHERE owner_email=$1", [email]);
        for (const t of ["shopping_lists WHERE owner_email", "allocations WHERE owner_email","web_sessions WHERE email", "auth_challenges WHERE email", "users WHERE email"]) await this.query(`DELETE FROM ${t}=$1`, [email]);
        await this.query("COMMIT");
      } catch (error) { await this.query("ROLLBACK").catch(() => {}); throw error; }
    });
  }
  async getAllocation(id: string) { const { rows } = await this.query("SELECT * FROM allocations WHERE id=$1", [id]); return rows[0] ? toAllocation(rows[0]) : undefined; }
  async findAllocationByTxSignature(signature: string) { const { rows } = await this.query("SELECT * FROM allocations WHERE tx_signature=$1", [signature]); return rows[0] ? toAllocation(rows[0]) : undefined; }
  async saveAllocation(a: StoredAllocation) {
    try {
      const { rows } = await this.query(
        "INSERT INTO allocations (id, owner_email, pouch_id, amount, wallet, status, created_at, tx_signature, top_up_signature, completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, tx_signature=EXCLUDED.tx_signature, top_up_signature=EXCLUDED.top_up_signature, completed_at=EXCLUDED.completed_at RETURNING *",
        [a.id, a.ownerEmail, a.pouchId, a.amount, a.wallet, a.status, a.createdAt, a.txSignature ?? null, a.topUpSignature ?? null, a.completedAt ?? null]);
      return toAllocation(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new StoreConflictError("Signature already used");
      throw e;
    }
  }
  async listTopUps(pouchId: string) { return (await this.query("SELECT * FROM topups WHERE pouch_id=$1 ORDER BY created_at DESC",[pouchId])).rows.map(toTopUp); }
  async getWithdrawal(id: string) { const { rows } = await this.query("SELECT * FROM withdrawals WHERE id=$1 ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? toWithdrawal(rows[0]) : undefined; }
  async listWithdrawals(pouchId: string) { return (await this.query("SELECT * FROM withdrawals WHERE pouch_id=$1 ORDER BY created_at DESC", [pouchId])).rows.map(toWithdrawal); }
  async listDueWithdrawals(now: Date) { return (await this.query("SELECT * FROM withdrawals WHERE status IN ('holding','processing') AND ready_at <= $1 ORDER BY ready_at", [now.toISOString()])).rows.map(toWithdrawal); }
  async saveWithdrawal(w: Withdrawal) { return toWithdrawal(await this.save("withdrawals", w, { created_at: w.createdAt, pouch_id: w.pouchId, amount: w.amount, reason: w.reason, to_wallet: w.toWallet, status: w.status, ready_at: w.readyAt, tx_signature: w.txSignature ?? null, fail_reason: w.failReason ?? null })); }

  async getUser(email: string) {
    const { rows } = await this.query("SELECT * FROM users WHERE email = $1", [email]);
    return rows[0] ? toUser(rows[0]) : undefined;
  }
  async saveUser(u: UserProfile) {
    // A profile save never changes or clears a linked wallet, so it cannot undo a concurrent link.
    const { rows } = await this.query(
      `INSERT INTO users (email, display_name, avatar, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET display_name=$2, avatar=$3, updated_at=$5 RETURNING *`,
      [u.email, u.displayName ?? null, u.avatar ?? null, u.createdAt, u.updatedAt],
    );
    const saved = toUser(rows[0]);
    if (!u.wallet || saved.wallet) return saved;
    // First link only (same rules as setWallet): another account holding it is a StoreConflictError.
    try { return await this.setWallet(u.email, u.wallet); }
    catch (e) { if (e instanceof WalletAlreadyLinkedError) return (await this.getUser(u.email)) ?? saved; throw e; }
  }
  async findUserByWallet(wallet: string) { const { rows } = await this.query("SELECT * FROM users WHERE wallet=$1", [wallet]); return rows[0] ? toUser(rows[0]) : undefined; }
  async setWallet(email: string, wallet: string | null) {
    try {
      // Conditional upsert: a link only lands when the account has no wallet or already has this one.
      const { rows } = await this.query(
        `INSERT INTO users (email, wallet, created_at, updated_at) VALUES ($1,$2,now(),now())
         ON CONFLICT (email) DO UPDATE SET wallet=$2, updated_at=now()
         WHERE $2::text IS NULL OR users.wallet IS NULL OR users.wallet = $2::text RETURNING *`, [email, wallet]);
      if (!rows[0]) throw new WalletAlreadyLinkedError();
      return toUser(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new StoreConflictError("This wallet is linked to another account");
      throw error;
    }
  }

  async updateUser(email: string, patch: UserPatch, now: string) {
    const has = (v: unknown) => v !== undefined;
    try {
      const { rows } = await this.query(
        `INSERT INTO users (email, display_name, avatar, wallet, created_at, updated_at) VALUES ($1,$2::text,$3::text,$4::text,$8::timestamptz,$8::timestamptz)
         ON CONFLICT (email) DO UPDATE SET
           display_name = CASE WHEN $5::boolean THEN $2::text ELSE users.display_name END,
           avatar = CASE WHEN $6::boolean THEN $3::text ELSE users.avatar END,
           wallet = CASE WHEN $7::boolean THEN $4::text ELSE users.wallet END,
           updated_at = $8::timestamptz
         RETURNING *`,
        [email, patch.displayName ?? null, patch.avatar ?? null, patch.wallet ?? null, has(patch.displayName), has(patch.avatar), has(patch.wallet), now],
      );
      return toUser(rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new StoreConflictError("This wallet is linked to another account");
      throw error;
    }
  }
  async saveChallenge(c: AuthChallenge) {
    await this.cleanupExpired();
    const { rowCount } = await this.query("INSERT INTO auth_challenges (id,wallet,email,session_id,origin,message,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING", [c.id, c.wallet, c.email, c.sessionId, c.origin, c.message, c.expiresAt]);
    if (!rowCount) throw new StoreConflictError("Challenge already exists");
  }
  async consumeChallenge(id: string) {
    const { rows } = await this.query("DELETE FROM auth_challenges WHERE id=$1 RETURNING *", [id]);
    const r = rows[0];
    // Rows from before the session/origin binding (null columns) never verify.
    return r && r.email && r.session_id && r.origin && Date.parse(iso(r.expires_at)) > Date.now() ? { id: r.id, wallet: r.wallet, email: r.email as string, sessionId: r.session_id as string, origin: r.origin as string, message: r.message, expiresAt: iso(r.expires_at) } : undefined;
  }
  async consumeRateLimit(key: string, windowMs: number, max: number) {
    validateRateLimit(key, windowMs, max);
    await this.cleanupExpired();
    const { rows } = await this.query(`INSERT INTO rate_limit_buckets (key,hits,expires_at)
      VALUES ($1,1,now()+$2::bigint*interval '1 millisecond')
      ON CONFLICT (key) DO UPDATE SET
        hits=CASE WHEN rate_limit_buckets.expires_at <= now() THEN 1 ELSE rate_limit_buckets.hits+1 END,
        expires_at=CASE WHEN rate_limit_buckets.expires_at <= now() THEN now()+$2::bigint*interval '1 millisecond' ELSE rate_limit_buckets.expires_at END
      RETURNING hits, GREATEST(1,ceil(extract(epoch FROM (expires_at-now())))) AS retry_after`, [key, windowMs]);
    return { allowed: Number(rows[0].hits) <= max, retryAfterSeconds: Number(rows[0].retry_after) };
  }

  async recordVaultEvents(events: VaultEventRecord[], payments: PaymentRecord[]) {
    if (!events.length) return 0;
    // One dedicated connection per transaction so BEGIN/COMMIT cover every insert.
    // Same lock as recordPayment: a direct write of the same paid order and the indexer cannot both insert it.
    return this.lock(`payment:${events[0]!.signature}`, async () => {
      await this.query("BEGIN");
      try {
        let inserted = 0;
        for (const e of events) {
          const { rowCount } = await this.query(
            `INSERT INTO vault_events (signature,event_index,name,pouch_address,amount,time,slot,data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (signature,event_index) DO NOTHING`,
            [e.signature, e.eventIndex, e.name, e.pouchAddress, e.amount, e.time, e.slot, JSON.stringify(e.data)]);
          if (!rowCount) continue;
          inserted++;
          const p = payments.find((x) => x.txSignature === e.signature && x.eventIndex === e.eventIndex);
          if (p) await this.insertPayment(p);
        }
        await this.query("COMMIT");
        return inserted;
      } catch (error) {
        await this.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  }
  async getIndexerCursor(name: string) {
    const { rows } = await this.query("SELECT signature, slot FROM indexer_cursors WHERE name=$1", [name]);
    return rows[0] ? { signature: rows[0].signature as string, slot: Number(rows[0].slot) } : undefined;
  }
  async saveIndexerCursor(name: string, c: IndexerCursor) {
    await this.query(`INSERT INTO indexer_cursors (name,signature,slot,updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (name) DO UPDATE SET signature=$2, slot=$3, updated_at=now()`, [name, c.signature, c.slot]);
  }
  async indexedSpend(pouchIds: string[], bucket: "day" | "hour"): Promise<SpendPoint[] | undefined> {
    if (!pouchIds.length) return undefined;
    const { rows: any } = await this.query("SELECT 1 FROM payments WHERE pouch_id = ANY($1::text[]) LIMIT 1", [pouchIds]);
    if (!any.length) return undefined;
    // Aggregate payments directly. spend_daily only re-materializes its last 3 days, so a
    // payment indexed late (backfill, indexer downtime) would be missing from older buckets.
    const { rows } = await this.query(
      "SELECT time_bucket($2::interval, time) AS bucket, pouch_id, sum(amount) AS spent, count(*) AS orders FROM payments WHERE pouch_id = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1, 2",
      [pouchIds, bucket === "day" ? "1 day" : "1 hour"]);
    return rows.map((r) => ({ bucket: iso(r.bucket), pouchId: r.pouch_id, spent: Number(r.spent), orders: Number(r.orders) }));
  }

  async indexedOrderIds(pouchIds: string[], orderIds: string[]): Promise<Set<string>> {
    if (!pouchIds.length || !orderIds.length) return new Set();
    const { rows } = await this.query(
      "SELECT DISTINCT lower(order_id) AS order_id FROM payments WHERE pouch_id = ANY($1::text[]) AND lower(order_id) = ANY($2::text[])",
      [pouchIds, orderIds.map((id) => id.toLowerCase())],
    );
    return new Set(rows.map((r) => String(r.order_id)));
  }
}
