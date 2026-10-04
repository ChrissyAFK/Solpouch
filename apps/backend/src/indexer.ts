// Read-only chain indexer for the solpouch_vault program.
//
// Live: connection.onLogs(programId) is only a trigger. Every trigger (and a
// periodic poll, which covers dropped websocket notifications) runs the same
// catch-up: getSignaturesForAddress back to the persisted cursor, then each
// transaction's logs are fetched and decoded oldest first. The cursor advances
// one transaction at a time after its events are stored, so a crash resumes
// where it stopped. Writes are idempotent on (signature, event index).
//
// This module never loads a keypair and never signs or sends a transaction.
import { BorshCoder, EventParser, type Coder, type Idl } from "@coral-xyz/anchor";
import type { ConfirmedSignatureInfo, Connection, Finality } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { merchants } from "./merchants/index.js";
import type { IndexerCursor, PaymentIndex, PaymentRecord, Store, VaultEventRecord } from "./store/types.js";
import idlJson from "./vault/idl/solpouch_vault.json" with { type: "json" };

export const INDEXER_CURSOR = "solpouch_vault";
const COMMITMENT: Finality = "confirmed";
const PAGE = 1000;

/** The RPC surface the indexer uses (a web3.js Connection satisfies it). */
export type IndexerConnection = Pick<Connection, "getSignaturesForAddress" | "getTransaction" | "onLogs" | "removeOnLogsListener">;
type Log = (message: string) => void;

export interface DecodedEvent { name: string; data: Record<string, unknown>; index: number }

/** Decode this program's Anchor events from one transaction's logs. Unknown or undecodable events are skipped. */
export function createEventDecoder(programId: PublicKey, idl: Idl = idlJson as Idl, log: Log = console.warn) {
  const inner = new BorshCoder(idl);
  // A known discriminator whose layout changed must not stop the transaction's other events.
  const tolerant = { events: { decode: (s: string) => {
    try { return inner.events.decode(s); } catch { log("[indexer] skipped an event that does not match the IDL layout"); return null; }
  } } } as unknown as Coder;
  const parser = new EventParser(programId, tolerant);
  return (logs: string[]): DecodedEvent[] => {
    const out: DecodedEvent[] = [];
    try {
      for (const e of parser.parseLogs(logs)) out.push({ name: e.name, data: e.data as Record<string, unknown>, index: out.length });
    } catch {
      log("[indexer] could not parse a transaction's logs; keeping the events decoded so far");
    }
    return out;
  };
}

function field(data: Record<string, unknown>, snake: string): unknown {
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return data[snake] ?? data[camel];
}
/** JSON-safe copy: public keys as base58, integers (BN) as decimal strings, byte arrays as hex. */
function plain(v: unknown): unknown {
  if (v instanceof PublicKey || (v && typeof v === "object" && typeof (v as { toBase58?: unknown }).toBase58 === "function")) return (v as PublicKey).toBase58();
  if (v && typeof v === "object" && typeof (v as { toArrayLike?: unknown }).toArrayLike === "function") return String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.length && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? Buffer.from(v as number[]).toString("hex") : v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}
function safeInt(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(String(v));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export interface TxContext { signature: string; slot: number; blockTime: number | null | undefined }
export interface Lookup {
  /** Pouch PDA (base58) -> stored pouch ID. */
  pouchIdByAddress: Map<string, string>;
  /** Order ID (hex) -> merchant ID of the stored order, if any. */
  orderMerchant: (orderId: string) => Promise<string | undefined>;
}

/** Map decoded events to rows. Every event -> vault_events; PaymentMade also -> payments. */
export async function toRows(tx: TxContext, events: DecodedEvent[], lookup: Lookup, log: Log = console.warn): Promise<{ events: VaultEventRecord[]; payments: PaymentRecord[] }> {
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString();
  const rows: VaultEventRecord[] = [];
  const payments: PaymentRecord[] = [];
  for (const e of events) {
    const data = plain(e.data) as Record<string, unknown>;
    const pouch = field(data, "pouch");
    const pouchAddress = typeof pouch === "string" ? pouch : null;
    const amount = safeInt(field(data, "amount"));
    const eventTime = safeInt(field(data, "time"));
    const time = eventTime ? new Date(eventTime * 1000).toISOString() : blockTime;
    switch (e.name) {
      case "PaymentMade": {
        const orderId = field(data, "order_id");
        const merchant = field(data, "merchant");
        if (!pouchAddress || amount === null || typeof orderId !== "string" || typeof merchant !== "string") {
          log(`[indexer] PaymentMade in ${tx.signature} is missing fields; recorded as an event only`);
          break;
        }
        const merchantId = (await lookup.orderMerchant(orderId)) ?? merchants.find((m) => m.payTo === merchant)?.id ?? null;
        payments.push({ txSignature: tx.signature, eventIndex: e.index, time, pouchId: lookup.pouchIdByAddress.get(pouchAddress) ?? pouchAddress, merchantId, orderId, amount });
        break;
      }
      case "ToppedUp": case "Withdrawn": case "Frozen": case "Unfrozen":
        break;
      default:
        // New program events (e.g. PouchCreated, RulesSet, PouchClosed) are kept generically.
        log(`[indexer] recording event ${e.name} without special handling`);
    }
    rows.push({ signature: tx.signature, eventIndex: e.index, name: e.name, pouchAddress, amount, time, slot: tx.slot, data });
  }
  return { events: rows, payments };
}

export interface IndexerOptions {
  connection: IndexerConnection;
  programId: PublicKey;
  store: Store & PaymentIndex;
  idl?: Idl;
  pollMs?: number;
  log?: Log;
}

export class VaultIndexer {
  private decode: (logs: string[]) => DecodedEvent[];
  private log: Log;
  private running?: Promise<number>;
  private again = false;
  private started = false;
  private stopped = false;
  private listener?: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private opts: IndexerOptions) {
    this.log = opts.log ?? console.warn;
    this.decode = createEventDecoder(opts.programId, opts.idl, this.log);
  }

  /** Subscribe, poll, and run the first backfill. Resolves after that backfill attempt. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.listener = this.opts.connection.onLogs(this.opts.programId, (logs) => { if (!logs.err) this.trigger(); }, COMMITMENT);
    this.timer = setInterval(() => this.trigger(), this.opts.pollMs ?? 30_000);
    this.timer.unref?.();
    await this.sync().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    if (this.listener !== undefined) await this.opts.connection.removeOnLogsListener(this.listener).catch(() => {});
    this.listener = undefined;
    await this.running?.catch(() => {});
  }

  private trigger() { void this.sync().catch(() => {}); }

  /** Single-flight catch-up. A call during a run shares it and schedules one more pass. */
  sync(): Promise<number> {
    if (this.running) { this.again = true; return this.running; }
    const run = (async () => {
      let total = 0;
      do { this.again = false; total += await this.catchUp(); } while (this.again && !this.stopped);
      return total;
    })();
    this.running = run;
    run.catch((e) => this.log(`[indexer] sync failed, will retry: ${(e as Error)?.message ?? "unknown error"}`))
      .finally(() => { if (this.running === run) this.running = undefined; });
    return run;
  }

  private async pendingSignatures(cursor: IndexerCursor | undefined): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    // Newest first, back to (not including) the cursor. Never skip a page: a gap would be lost for good.
    for (;;) {
      const page = await this.opts.connection.getSignaturesForAddress(this.opts.programId, { limit: PAGE, ...(before ? { before } : {}), ...(cursor ? { until: cursor.signature } : {}) }, COMMITMENT);
      all.push(...page);
      if (page.length < PAGE) break;
      if (this.stopped) return [];
      before = page[page.length - 1]!.signature;
    }
    return all.reverse();
  }

  private async catchUp(): Promise<number> {
    const { store, connection } = this.opts;
    const cursor = await store.getIndexerCursor(INDEXER_CURSOR);
    const pending = await this.pendingSignatures(cursor);
    if (!pending.length) return 0;
    const pouchIdByAddress = new Map((await store.listPouches()).map((p) => [p.address, p.id]));
    const lookup: Lookup = { pouchIdByAddress, orderMerchant: async (id) => (await store.getOrder(id))?.merchantId };
    let inserted = 0;
    for (const sig of pending) {
      if (this.stopped) break;
      if (!sig.err) {
        const tx = await connection.getTransaction(sig.signature, { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 });
        // Not yet served by this RPC node: stop and retry later without moving the cursor.
        if (!tx) throw new Error(`transaction ${sig.signature} is not available yet`);
        if (!tx.meta?.err) {
          const rows = await toRows({ signature: sig.signature, slot: tx.slot, blockTime: tx.blockTime ?? sig.blockTime }, this.decode(tx.meta?.logMessages ?? []), lookup, this.log);
          if (rows.events.length) inserted += await store.recordVaultEvents(rows.events, rows.payments);
        }
      }
      await store.saveIndexerCursor(INDEXER_CURSOR, { signature: sig.signature, slot: sig.slot });
    }
    return inserted;
  }
}

/** Why the indexer should not run in this environment, or undefined when it should. */
export function indexerDisabledReason(env: NodeJS.ProcessEnv, hasPostgres: boolean): string | undefined {
  if (env.ENABLE_INDEXER !== "true") return "ENABLE_INDEXER is not true";
  if (env.VAULT_MODE !== "chain") return "VAULT_MODE is not chain";
  if (!hasPostgres) return "no Postgres store (DATABASE_URL) is configured";
  if (!env.VAULT_PROGRAM_ID) return "VAULT_PROGRAM_ID is not set";
  return undefined;
}
