import type { Pool } from 'pg';
import type { FundingRequest } from './types.js';

export interface FundingRepository {
  create(request: FundingRequest): Promise<{request: FundingRequest; created: boolean}>;
  get(id: string): Promise<FundingRequest | undefined>;
  list(owner: string): Promise<FundingRequest[]>;
  update(id: string, mutate: (record: FundingRequest) => FundingRequest): Promise<FundingRequest>;
  /** Account deletion: removes every request the owner made. */
  deleteOwner(owner: string): Promise<void>;
}
export class PostgresFundingRepository implements FundingRepository {
  constructor(private pool: Pool) {}
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS funding_requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, data JSONB NOT NULL, UNIQUE(owner,idempotency_key))`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS funding_provider_order_unique ON funding_requests ((data->>'providerOrderId')) WHERE data->>'providerOrderId' IS NOT NULL`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS funding_receipt_unique ON funding_requests ((data->>'txSignature')) WHERE data->>'txSignature' IS NOT NULL AND data->>'status' = 'confirmed'`);
  }
  async create(request: FundingRequest) {
    const inserted = await this.pool.query('INSERT INTO funding_requests(id,owner,idempotency_key,data) VALUES($1,$2,$3,$4) ON CONFLICT(owner,idempotency_key) DO NOTHING RETURNING data',[request.id,request.owner,request.idempotencyKey,request]);
    if (inserted.rowCount) return {request: inserted.rows[0].data as FundingRequest, created: true};
    const found = await this.pool.query('SELECT data FROM funding_requests WHERE owner=$1 AND idempotency_key=$2',[request.owner,request.idempotencyKey]);
    if (!found.rows[0]) throw new Error('Funding request unavailable');
    return {request: found.rows[0].data as FundingRequest,created: false};
  }
  async get(id: string) { const r=await this.pool.query('SELECT data FROM funding_requests WHERE id=$1',[id]); return r.rows[0]?.data as FundingRequest | undefined; }
  async list(owner: string) { const r=await this.pool.query('SELECT data FROM funding_requests WHERE owner=$1 ORDER BY data->>\'createdAt\' DESC LIMIT 100',[owner]); return r.rows.map(row=>row.data as FundingRequest); }
  async deleteOwner(owner: string) { await this.pool.query('DELETE FROM funding_requests WHERE owner=$1',[owner]); }
  async update(id: string, mutate: (record: FundingRequest) => FundingRequest) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '3s'");
      await c.query("SET LOCAL statement_timeout = '10s'");
      const r=await c.query('SELECT data FROM funding_requests WHERE id=$1 FOR UPDATE',[id]);
      if (!r.rows[0]) throw new Error('Funding request missing');
      const next=mutate(r.rows[0].data as FundingRequest);
      await c.query('UPDATE funding_requests SET data=$2 WHERE id=$1',[id,next]);
      await c.query('COMMIT'); return next;
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
}
/** Explicit unit-test fixture. Never select this for a server deployment. */
export class MemoryFundingRepository implements FundingRepository {
  private records=new Map<string,FundingRequest>();
  async create(record: FundingRequest) {
    const prior=[...this.records.values()].find(r=>r.owner===record.owner && r.idempotencyKey===record.idempotencyKey);
    if(prior) return {request: structuredClone(prior),created:false};
    this.records.set(record.id,structuredClone(record)); return {request:structuredClone(record),created:true};
  }
  async get(id:string) { const r=this.records.get(id); return r ? structuredClone(r) : undefined; }
  async list(owner:string) { return structuredClone([...this.records.values()].filter(r=>r.owner===owner)); }
  async deleteOwner(owner:string) { for(const [id,r] of this.records) if(r.owner===owner) this.records.delete(id); }
  async update(id:string,mutate:(r:FundingRequest)=>FundingRequest) {
    const r=this.records.get(id); if(!r) throw new Error('Funding request missing');
    const next=mutate(structuredClone(r));
    if([...this.records.values()].some(other=>other.id!==id && ((next.providerOrderId && other.providerOrderId===next.providerOrderId) || (next.status==='confirmed' && other.status==='confirmed' && next.txSignature && other.txSignature===next.txSignature)))) throw new Error('Funding receipt already claimed');
    this.records.set(id,structuredClone(next)); return structuredClone(next);
  }
}
