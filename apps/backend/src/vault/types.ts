import type { Micros, Pouch, VaultError } from "@solpouch/shared";

export type VaultRejectCode = VaultError | "OrderAlreadyUsed";

export class VaultRejected extends Error {
  constructor(public code: VaultRejectCode) {
    super(`Vault rejected: ${code}`);
    this.name = "VaultRejected";
  }
}

export type VaultState = Pick<Pouch, "balance" | "spentToday" | "frozen" | "maxPerOrder" | "dailyLimit" | "allowedMerchantIds">;

export interface VaultClient {
  getState?(pouchId: string): Promise<VaultState>;
  readonly authorizedOwner?: string;
  /** Create the pouch account on the vault. Returns its address (PDA). */
  createPouch(pouch: Pouch): Promise<{ address: string }>;
  /** Owner-only on chain. The backend only calls this from the friction top-up flow. */
  topUp(pouchId: string, amount: Micros, operationId?: string): Promise<{ txSignature: string }>;
  /** Agent key call. Throws VaultRejected when the program would refuse. */
  pay(pouch: Pouch, merchantPayTo: string, amount: Micros, orderId: string): Promise<{ txSignature: string }>;
  freeze(pouchId: string): Promise<{ txSignature: string }>;
  unfreeze(pouchId: string): Promise<{ txSignature: string }>;
  getBalance(pouchId: string): Promise<{ balance: Micros; spentToday: Micros }>;
  /** Owner updates rules on chain. */
  updateRules(pouch: Pouch): Promise<{ txSignature: string }>;
}
