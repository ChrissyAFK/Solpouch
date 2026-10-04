import type { Store, VaultOperation } from "../store/types.js";
import { VaultRejected, type VaultRejectCode } from "./types.js";

/** An unresolved operation must retain its identity; never create a replacement transaction. */
export class PaymentPending extends Error {
  constructor(message = "Payment status is not confirmed. Retry this same request to check it again.") {
    super(message);
    this.name = "PaymentPending";
  }
}

export interface RecoveryTransport {
  /** `seen` (or its older name `found`) is false only when the cluster has no record of the signature at all;
   * missing history alone is not proof a transaction never landed. `failed` means a confirmed failure.
   * `rejectCode` names the vault program error of a transaction that landed and failed. */
  status(signature: string): Promise<{ confirmed: boolean; failed: boolean; seen?: boolean; found?: boolean; rejectCode?: VaultRejectCode }>;
  blockHeight(): Promise<number>;
  broadcast(bytes: Uint8Array): Promise<unknown>;
  confirm(operation: VaultOperation): Promise<{ failed: boolean; rejectCode?: VaultRejectCode }>;
  /** Returns the vault error when a broadcast was refused by preflight simulation, which means it never ran. */
  rejection?(error: unknown): VaultRejectCode | undefined;
}

/** A program error is final only when it cannot hide an earlier success.
 * OrderAlreadyUsed may mean this same payment already landed, so it stays pending. */
function finalRejection(code: VaultRejectCode | undefined): code is VaultRejectCode {
  return !!code && code !== "OrderAlreadyUsed";
}

/** A transaction confirmed as failed moved no tokens and cannot land later, so it is final: the program's own
 * error when known, else TxFailed. OrderAlreadyUsed may hide an earlier success of this payment, so it stays pending. */
function failedOnChain(code: VaultRejectCode | undefined): VaultRejected | PaymentPending {
  if (code === "OrderAlreadyUsed") return new PaymentPending("The transaction failed on chain. It needs review before a new payment can be started.");
  return new VaultRejected(code ?? "TxFailed");
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
  // Only a transaction signed in this call has never been broadcast before.
  const firstBroadcast = !operation;
  if (!operation) {
    operation = await prepare();
    if (operation.id !== id || operation.kind !== expected.kind || operation.pouchId !== expected.pouchId) throw new Error("Payment journal context does not match the request");
    await store.saveOperation(operation);
  }
  if (operation.id !== id || operation.kind !== expected.kind || operation.pouchId !== expected.pouchId) throw new Error("Payment journal context does not match the request");
  const status = await transport.status(operation.txSignature);
  if (status.confirmed) return { txSignature: operation.txSignature };
  if (status.failed) throw failedOnChain(status.rejectCode);
  if (await transport.blockHeight() > operation.lastValidBlockHeight) {
    throw new PaymentPending("The transaction expired without a confirmed result. It needs review; no replacement payment was sent.");
  }
  try {
    await transport.broadcast(Buffer.from(operation.signedTransaction, "base64"));
    const result = await transport.confirm(operation);
    if (result.failed) throw failedOnChain(result.rejectCode);
    return { txSignature: operation.txSignature };
  } catch (error) {
    if (error instanceof PaymentPending || error instanceof VaultRejected) throw error;
    // Preflight refusals never reach the cluster. On a retry an earlier broadcast of
    // the same bytes may still be in flight and land before lastValidBlockHeight,
    // so only the first broadcast's refusal is final, and only for an unseen signature.
    const code = transport.rejection?.(error);
    if (firstBroadcast && finalRejection(code)) {
      const after = await transport.status(operation.txSignature).catch(() => undefined);
      if ((after?.seen === false || after?.found === false)) throw new VaultRejected(code);
    }
    // RPC timeouts can occur after acceptance. A later retry checks this signature first.
    throw new PaymentPending();
  }
}
