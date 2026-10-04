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
  /** Missing history is not proof a transaction never landed. */
  status(signature: string): Promise<{ confirmed: boolean; failed: boolean; found?: boolean }>;
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
  // A confirmed failure is terminal; absent RPC history remains ambiguous.
  if (status.failed) throw new VaultRejected("TxFailed");
  if (await transport.blockHeight() > operation.lastValidBlockHeight) {
    throw new PaymentPending("The transaction expired without a confirmed result. It needs review; no replacement payment was sent.");
  }
  try {
    await transport.broadcast(Buffer.from(operation.signedTransaction, "base64"));
    const result = await transport.confirm(operation);
    if (result.failed) throw new ConfirmedFailure();
    return { txSignature: operation.txSignature };
  } catch (error) {
    // RPC timeouts can occur after acceptance. A later retry checks this signature first.
    if (error instanceof ConfirmedFailure) throw new VaultRejected("TxFailed");
    if (error instanceof PaymentPending) throw error;
    throw new PaymentPending();
  }
}

class ConfirmedFailure extends Error {}
