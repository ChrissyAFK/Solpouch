import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
export interface StripeFundingRequest {
    id: string;
    provider: 'stripe';
    owner: string;
    idempotencyKey: string;
    wallet: string;
    amountCad: string;
    amountCents: number;
    usdPerCad: string;
    usdcMicros: number;
    usdcAmount: string;
    status: 'created' | 'checkout_ready' | 'paid' | 'confirmed' | 'expired';
    createdAt: string;
    sessionId?: string;
    checkoutUrl?: string;
    txSignature?: string;
    mintOperation?: {
        requestId: string;
        wallet: string;
        mint: string;
        amountMicros: string;
        signature: string;
        rawTransaction: string;
        lastValidBlockHeight: number;
    };
}
export interface StripeRepository {
    create(r: StripeFundingRequest): Promise<StripeFundingRequest>;
    get(id: string): Promise<StripeFundingRequest | undefined>;
    list(owner: string): Promise<StripeFundingRequest[]>;
    bySession(id: string): Promise<StripeFundingRequest | undefined>;
    update(id: string, mutate: (r: StripeFundingRequest) => StripeFundingRequest): Promise<StripeFundingRequest>;
    withLock<T>(id: string, fn: () => Promise<T>): Promise<T>;
}
export class PostgresStripeRepository implements StripeRepository {
    private lockState = new AsyncLocalStorage<{
        lost: boolean;
        client: PoolClient;
    }>();
    constructor(private pool: Pool) { }
    private assertLock() { if (this.lockState.getStore()?.lost)
        throw new Error("Funding lock connection was lost; retry the same request."); }
    async initialize() { await this.pool.query(`CREATE TABLE IF NOT EXISTS stripe_funding_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,idempotency_key TEXT NOT NULL,data JSONB NOT NULL,UNIQUE(owner,idempotency_key)); CREATE UNIQUE INDEX IF NOT EXISTS stripe_funding_session ON stripe_funding_requests ((data->>'sessionId')) WHERE data->>'sessionId' IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS stripe_funding_signature ON stripe_funding_requests ((data->>'txSignature')) WHERE data->>'txSignature' IS NOT NULL`); }
    async create(r: StripeFundingRequest) { const result = await this.pool.query('INSERT INTO stripe_funding_requests VALUES($1,$2,$3,$4) ON CONFLICT(owner,idempotency_key) DO NOTHING RETURNING data', [r.id, r.owner, r.idempotencyKey, r]); if (result.rows[0])
        return result.rows[0].data as StripeFundingRequest; return (await this.pool.query('SELECT data FROM stripe_funding_requests WHERE owner=$1 AND idempotency_key=$2', [r.owner, r.idempotencyKey])).rows[0].data as StripeFundingRequest; }
    async get(id: string) { this.assertLock(); return (await (this.lockState.getStore()?.client ?? this.pool).query('SELECT data FROM stripe_funding_requests WHERE id=$1', [id])).rows[0]?.data as StripeFundingRequest | undefined; }
    async list(owner: string) { return (await this.pool.query('SELECT data FROM stripe_funding_requests WHERE owner=$1 ORDER BY data->>\'createdAt\' DESC LIMIT 100', [owner])).rows.map(r => r.data as StripeFundingRequest); }
    async bySession(id: string) { return (await this.pool.query("SELECT data FROM stripe_funding_requests WHERE data->>'sessionId'=$1", [id])).rows[0]?.data as StripeFundingRequest | undefined; }
    async update(id: string, mutate: (r: StripeFundingRequest) => StripeFundingRequest) { this.assertLock(); const held = this.lockState.getStore(); const c = held?.client ?? await this.pool.connect(); try {
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");
        const old = (await c.query('SELECT data FROM stripe_funding_requests WHERE id=$1 FOR UPDATE', [id])).rows[0]?.data;
        if (!old)
            throw Error('Funding request missing');
        this.assertLock();
        const next = mutate(old);
        await c.query('UPDATE stripe_funding_requests SET data=$2 WHERE id=$1', [id, next]);
        this.assertLock();
        await c.query('COMMIT');
        return next;
    }
    catch (e) {
        await c.query('ROLLBACK');
        throw e;
    }
    finally {
        if (!held) c.release();
    } }
    async withLock<T>(id: string, fn: () => Promise<T>) { const c = await this.pool.connect(); const state = { lost: false, client: c }; const lost = () => { state.lost = true; }; c.on('error', lost); let acquired = false; try {
        const result = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [`stripe:${id}`]);
        acquired = !!result.rows[0].locked;
        if (!acquired)
            throw new StripeBusy();
        return await this.lockState.run(state, async () => { this.assertLock(); const result = await fn(); this.assertLock(); return result; });
    }
    finally {
        try {
            if (acquired && !state.lost)
                await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`stripe:${id}`]);
        }
        catch {
            state.lost = true;
        }
        finally {
            c.removeListener('error', lost);
            c.release(state.lost);
        }
    } }
}
export class StripeBusy extends Error {
}
/** Explicit isolated test fixture; never use for server funding. */
export class MemoryStripeRepository implements StripeRepository {
    records = new Map<string, StripeFundingRequest>();
    private locked = new Set<string>();
    async create(r: StripeFundingRequest) { const old = [...this.records.values()].find(v => v.owner === r.owner && v.idempotencyKey === r.idempotencyKey); if (old)
        return structuredClone(old); this.records.set(r.id, structuredClone(r)); return structuredClone(r); }
    async get(id: string) { const r = this.records.get(id); return r ? structuredClone(r) : undefined; }
    async list(owner: string) { return structuredClone([...this.records.values()].filter(r => r.owner === owner)); }
    async bySession(id: string) { const r = [...this.records.values()].find(v => v.sessionId === id); return r ? structuredClone(r) : undefined; }
    async update(id: string, mutate: (r: StripeFundingRequest) => StripeFundingRequest) { const r = await this.get(id); if (!r)
        throw Error('Missing request'); const next = mutate(r); if ([...this.records.values()].some(other => other.id !== id && ((next.sessionId && other.sessionId === next.sessionId) || (next.txSignature && other.txSignature === next.txSignature))))
        throw Error("Funding receipt already claimed"); this.records.set(id, structuredClone(next)); return structuredClone(next); }
    async withLock<T>(id: string, fn: () => Promise<T>) { if (this.locked.has(id))
        throw new StripeBusy(); this.locked.add(id); try {
        return await fn();
    }
    finally {
        this.locked.delete(id);
    } }
}
