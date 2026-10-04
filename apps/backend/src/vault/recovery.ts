import { VaultRejected } from "./types.js";
import type { Store, VaultOperation } from "../store/types.js";

/** An unresolved operation must retain its identity; never create a replacement transaction. */
export class PaymentPending extends Error {
  constructor(message = "Payment status is not confirmed. Retry this same request to check it again.") {
    super(message);
    this.name = "PaymentPending";
  }
}

export interface RecoveryTransport {
  status(signature: string): Promise<{ confirmed: boolean; failed: boolean }>;
  blockHeight(): Promise<number>;
  broadcast(bytes: Uint8Array): Promise<unknown>;
  confirm(operation: VaultOperation): Promise<{ failed: boolean }>;
}

/** Persist signed bytes before broadcast. The immutable journal survives process restarts. */
export async function recoverTransaction(
  store: Store,
  id: string,
  transport: RecoveryTransport,
  prepare: () => Promise<VaultOperation>,
  expected: Pick<VaultOperation, "kind" | "pouchId">,
): Promise<{ txSignature: string }> {
  let operation = await store.getOperation(id);
  if (!operation) {
    operation = await prepare();
    if (operation.id !== id || operation.kind !== expected.kind || operation.pouchId !== expected.pouchId) throw new Error("Payment journal context does not match the request");
    await store.saveOperation(operation);
  }
  if (operation.id !== id || operation.kind !== expected.kind || operation.pouchId !== expected.pouchId) throw new Error("Payment journal context does not match the request");
  const status = await transport.status(operation.txSignature);
  if (status.confirmed) return { txSignature: operation.txSignature };
  if (status.failed) throw new PaymentPending("The transaction failed on chain. It needs review before a new payment can be started.");
  if (await transport.blockHeight() > operation.lastValidBlockHeight) {
    throw new PaymentPending("The transaction expired without a confirmed result. It needs review; no replacement payment was sent.");
  }
  try {
    await transport.broadcast(Buffer.from(operation.signedTransaction, "base64"));
    const result = await transport.confirm(operation);
    if (result.failed) throw new PaymentPending("The transaction failed on chain. It needs review before a new payment can be started.");
    return { txSignature: operation.txSignature };
  } catch (error) {
    // RPC timeouts can occur after acceptance. A later retry checks this signature first.
    // A program refusal is terminal: nothing was broadcast, so the caller marks the order rejected.
    if (error instanceof PaymentPending || error instanceof VaultRejected) throw error;
    throw new PaymentPending();
  }
}
