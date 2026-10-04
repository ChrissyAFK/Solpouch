import { PostgresFundingRepository } from "../funding/repository.js";
import { HttpError } from "../services/orders.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Order, Pouch, TopUp } from "@solpouch/shared";
import { StoreConflictError, sameOperation, validateRateLimit, type Store, type VaultOperation, type AuthSession, type AuthChallenge, type StoredShoppingList, type StoredPouch, type UserProfile } from "./types.js";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
type Row = Record<string, any>;
function toShoppingList(r: Row): StoredShoppingList { return { id:r.id, ownerEmail:r.owner_email, version:Number(r.version), name:r.name, items:structuredClone(r.items), createdAt:iso(r.created_at), updatedAt:iso(r.updated_at) }; }
function toPouch(r: Row): StoredPouch {
  return { id: r.id, address: r.address, name: r.name, balance: Number(r.balance), maxPerOrder: Number(r.max_per_order), dailyLimit: Number(r.daily_limit), spentToday: Number(r.spent_today), confirmAbove: Number(r.confirm_above), allowedMerchantIds: structuredClone(r.allowed_merchant_ids), frozen: r.frozen, version: Number(r.version), ...(r.owner_email ? { ownerEmail: r.owner_email } : {}) };
}
function toOrder(r: Row): Order {
  return { id: r.id, pouchId: r.pouch_id, merchantId: r.merchant_id, request: r.request, lines: structuredClone(r.lines), total: Number(r.total), status: r.status, createdAt: iso(r.created_at), version: Number(r.version), ...(r.reject_reason ? { rejectReason: r.reject_reason } : {}), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}), ...(r.store ? {store:r.store}:{}), ...(r.fulfillment ? {fulfillment:r.fulfillment}:{}), ...(r.paid_at ? {paidAt:iso(r.paid_at)}:{}) };
}
function toTopUp(r: Row): TopUp {
  return { id: r.id, pouchId: r.pouch_id, amount: Number(r.amount), reason: r.reason, status: r.status, ...(r.completed_at ? {completedAt:iso(r.completed_at)}:{}), ...(r.from_wallet ? { fromWallet: r.from_wallet } : {}), readyAt: iso(r.ready_at), createdAt: iso(r.created_at), version: Number(r.version), ...(r.tx_signature ? { txSignature: r.tx_signature } : {}) };
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

export class PostgresStore implements Store {
  readonly persistentLists = true;
  private context = new AsyncLocalStorage<{ client: pg.PoolClient; locks: Set<string>; state: { error?: Error } }>();
  private nextCleanupAt = 0;
  private async cleanupExpired() {
    const now = Date.now();
    if (now < this.nextCleanupAt) return;
    this.nextCleanupAt = now + 60_000;
    // Limit each sweep so cleanup cannot monopolize a request or lock large tables.
    for (const [table, key] of [["auth_challenges", "id"], ["web_sessions", "id"], ["rate_limit_buckets", "key"]]) {
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

  private async save(table: "pouches" | "orders" | "topups" | "shopping_lists", record: { id: string; version?: number; createdAt?: string }, fields: Record<string, unknown>): Promise<Row> {
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
    return toPouch(await this.save("pouches", p, { address: p.address, name: p.name, balance: p.balance, max_per_order: p.maxPerOrder, daily_limit: p.dailyLimit, spent_today: p.spentToday, confirm_above: p.confirmAbove, allowed_merchant_ids: p.allowedMerchantIds, frozen: p.frozen, owner_email: p.ownerEmail ?? null }));
  }
  async listOrders(pouchId?: string) { return (await this.query(`SELECT * FROM orders ${pouchId ? "WHERE pouch_id=$1 " : ""}ORDER BY created_at DESC`, pouchId ? [pouchId] : undefined)).rows.map(toOrder); }
  async getOrder(id: string) { const { rows } = await this.query("SELECT * FROM orders WHERE id=$1 ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? toOrder(rows[0]) : undefined; }
  async saveOrder(o: Order) { return toOrder(await this.save("orders", o, { created_at: o.createdAt, pouch_id: o.pouchId, merchant_id: o.merchantId, request: o.request, lines: JSON.stringify(o.lines), total: o.total, status: o.status, reject_reason: o.rejectReason ?? null, tx_signature: o.txSignature ?? null, store: o.store ? JSON.stringify(o.store) : null, fulfillment: o.fulfillment ? JSON.stringify(o.fulfillment) : null, paid_at: o.paidAt ?? null })); }
  async getTopUp(id: string) { const { rows } = await this.query("SELECT * FROM topups WHERE id=$1 ORDER BY created_at DESC LIMIT 1", [id]); return rows[0] ? toTopUp(rows[0]) : undefined; }
  async saveTopUp(t: TopUp) { return toTopUp(await this.save("topups", t, { created_at: t.createdAt, pouch_id: t.pouchId, amount: t.amount, reason: t.reason, status: t.status, ready_at: t.readyAt, tx_signature: t.txSignature ?? null, completed_at: t.completedAt ?? null, from_wallet: t.fromWallet ?? null })); }

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
  async listTopUps(pouchId: string) { return (await this.query("SELECT * FROM topups WHERE pouch_id=$1 ORDER BY created_at DESC",[pouchId])).rows.map(toTopUp); }
  async getUser(email: string) { const { rows } = await this.query("SELECT * FROM users WHERE email=$1", [email]); return rows[0] ? toUser(rows[0]) : undefined; }
  async findUserByWallet(wallet: string) { const { rows } = await this.query("SELECT * FROM users WHERE wallet=$1", [wallet]); return rows[0] ? toUser(rows[0]) : undefined; }
  async saveUser(u: UserProfile) {
    try {
      await this.query(
        `INSERT INTO users (email, display_name, avatar, wallet, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (email) DO UPDATE SET display_name=$2, avatar=$3, wallet=$4, updated_at=$6`,
        [u.email, u.displayName ?? null, u.avatar ?? null, u.wallet ?? null, u.createdAt, u.updatedAt],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new StoreConflictError("This wallet is linked to another account");
      throw error;
    }
    return u;
  }

  async saveChallenge(c: AuthChallenge) {
    await this.cleanupExpired();
    const { rowCount } = await this.query("INSERT INTO auth_challenges (id,wallet,email,message,expires_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [c.id, c.wallet, c.email, c.message, c.expiresAt]);
    if (!rowCount) throw new StoreConflictError("Challenge already exists");
  }
  async consumeChallenge(id: string) {
    const { rows } = await this.query("DELETE FROM auth_challenges WHERE id=$1 RETURNING *", [id]);
    const r = rows[0];
    return r && r.email && Date.parse(iso(r.expires_at)) > Date.now() ? { id: r.id, wallet: r.wallet, email: r.email as string, message: r.message, expiresAt: iso(r.expires_at) } : undefined;
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
}
