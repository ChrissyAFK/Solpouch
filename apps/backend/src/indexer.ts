// Payment indexer stub. NOT wired into src/index.ts.
//
// TODO: once solpouch_vault is deployed:
//  1. connection.onLogs(new PublicKey(VAULT_PROGRAM_ID), ...) using SOLANA_RPC_URL.
//  2. Decode Anchor `PaymentMade` events with BorshCoder / EventParser and the program IDL.
//  3. INSERT INTO payments (time, pouch_id, merchant_id, order_id, amount, tx_signature)
//     ON CONFLICT DO NOTHING (using DATABASE_URL via pg).
//  4. On startup, backfill with getSignaturesForAddress so restarts do not lose events.
export async function startIndexer(): Promise<void> {
  throw new Error("indexer not implemented");
}
