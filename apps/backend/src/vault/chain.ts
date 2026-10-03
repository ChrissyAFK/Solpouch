import type { Micros, Pouch } from "@solpouch/shared";
import type { VaultClient } from "./types.js";

const NOT_READY = "not implemented until solpouch_vault is deployed";

export class ChainVaultClient implements VaultClient {
  rpcUrl: string;
  programId: string;
  agentKeypairPath: string;

  constructor() {
    this.rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
    this.programId = process.env.VAULT_PROGRAM_ID ?? "";
    this.agentKeypairPath = process.env.AGENT_KEYPAIR_PATH ?? "";
  }

  // TODO: Anchor `initialize_pouch`; derive the Pouch PDA from [owner, name]. Needs the OWNER signer (not the agent key).
  async createPouch(_pouch: Pouch): Promise<{ address: string }> {
    throw new Error(NOT_READY);
  }

  // TODO: Anchor `top_up`; owner signs, transfers USDC from owner ATA to the pouch vault ATA.
  async topUp(_pouchId: string, _amount: Micros): Promise<{ txSignature: string }> {
    throw new Error(NOT_READY);
  }

  // TODO: Anchor `pay` signed by the agent keypair (AGENT_KEYPAIR_PATH): accounts pouch, vault ATA, merchant ATA,
  // payment record PDA seeded by orderId (16 bytes). Map AnchorError names to VaultRejected(code).
  async pay(_p: Pouch, _merchantPayTo: string, _amount: Micros, _orderId: string): Promise<{ txSignature: string }> {
    throw new Error(NOT_READY);
  }

  // TODO: Anchor `set_frozen(true)`. (Agent may freeze; only the owner unfreezes.)
  async freeze(_pouchId: string): Promise<{ txSignature: string }> {
    throw new Error(NOT_READY);
  }

  // TODO: Anchor `set_frozen(false)`, owner signer.
  async unfreeze(_pouchId: string): Promise<{ txSignature: string }> {
    throw new Error(NOT_READY);
  }

  // TODO: fetch the Pouch account and the vault token account balance.
  async getBalance(_pouchId: string): Promise<{ balance: Micros; spentToday: Micros }> {
    throw new Error(NOT_READY);
  }

  // TODO: Anchor `update_rules`, owner signer.
  async updateRules(_pouch: Pouch): Promise<{ txSignature: string }> {
    throw new Error(NOT_READY);
  }
}
