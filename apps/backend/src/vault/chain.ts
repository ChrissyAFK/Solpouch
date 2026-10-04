import { readFileSync } from "node:fs";
import { allowedPayTos } from "./allow.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, BN, Program, Wallet, utils } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { merchants } from "../merchants/index.js";
import { checkoutPayTo } from "../services/fulfillment.js";
import { WEB_PREFIX, isAnyStore } from "@solpouch/shared";
import type { Store } from "../store/types.js";
import { recoverTransaction } from "./recovery.js";
import type { Micros, Pouch } from "@solpouch/shared";
import { VaultRejected, type VaultClient, type VaultRejectCode, type VaultState } from "./types.js";
import idlJson from "./idl/solpouch_vault.json" with { type: "json" };
import type { SolpouchVault } from "./idl/solpouch_vault.js";

// apps/backend/src/vault -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DAY_SECONDS = 86_400;
/** Micros are 6-decimal token units (USDC-style), so the mint has 6 decimals. */
const MINT_DECIMALS = 6;
const COMMITMENT = "confirmed" as const;

function loadKeypair(path: string): Keypair {
  const p = isAbsolute(path) ? path : resolve(REPO_ROOT, path);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

function nameBytes(id: string): Buffer {
  const raw = Buffer.from(id, "utf8");
  if (raw.length > 32) throw new VaultRejected("NameTooLong" as VaultRejectCode);
  const b = Buffer.alloc(32);
  raw.copy(b);
  return b;
}

function orderBytes(orderId: string): Buffer {
  const b = Buffer.from(orderId, "hex");
  if (b.length !== 16) throw new Error("orderId must be 32 hex chars");
  return b;
}

const PROGRAM_ERRORS = new Set([
  "Unauthorized",
  "PouchFrozen",
  "MerchantNotAllowed",
  "OverPerOrderLimit",
  "OverDailyLimit",
  "InsufficientFunds",
  "NameTooLong",
  "TooManyMerchants",
  "VaultNotEmpty",
]);

export function mapError(e: unknown): never {
  if (e instanceof VaultRejected) throw e;
  const anyE = e as { error?: { errorCode?: { code?: string; number?: number } }; message?: string; logs?: string[] };
  const code = anyE?.error?.errorCode?.code;
  if (code && PROGRAM_ERRORS.has(code)) throw new VaultRejected(code as VaultRejectCode);
  const text = `${anyE?.message ?? ""} ${(anyE?.logs ?? []).join(" ")}`;
  for (const name of PROGRAM_ERRORS) {
    if (text.includes(`Error Code: ${name}`)) throw new VaultRejected(name as VaultRejectCode);
  }
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    const entry = (idlJson as { errors?: { code: number; name: string }[] }).errors?.find((x) => x.code === parseInt(custom[1], 16));
    if (entry && PROGRAM_ERRORS.has(entry.name)) throw new VaultRejected(entry.name as VaultRejectCode);
  }
  if (/already in use/i.test(text)) throw new VaultRejected("OrderAlreadyUsed");
  // Anchor framework errors (2000-3999), System-program lamport shortfalls and SPL token insufficient funds.
  if (/insufficient lamports|insufficient funds for fee|no record of a prior credit/i.test(text)) throw new VaultRejected("SignerOutOfSol");
  const num = anyE?.error?.errorCode?.number ?? (/Error Number: (\d+)/.exec(text) ? Number(/Error Number: (\d+)/.exec(text)![1]) : custom ? parseInt(custom[1], 16) : undefined);
  if (num !== undefined && num >= 2000 && num <= 3999) {
    if (num === 3012 || num === 3007) throw new VaultRejected("PouchNotOnChain");
    if (num === 2001) throw new VaultRejected("AgentKeyMismatch");
    throw new VaultRejected("ChainRejected");
  }
  if (custom && parseInt(custom[1], 16) === 1) throw new VaultRejected("InsufficientFunds");
  throw e;
}

/** Resolve a pouch's pay-to addresses to at most 10 unique keys. Never truncates silently. */
export function resolveMerchantKeys(addresses: string[]): PublicKey[] {
  const unique = [...new Set(addresses)];
  if (unique.length > 10) throw new VaultRejected("TooManyMerchants");
  return unique.map((s) => new PublicKey(s));
}

/**
 * Map on-chain allowlist keys back to catalog ids. The shared checkout key stands for every web: entry,
 * and for any-store pouches (which also list every catalog merchant) it means "no restriction".
 */
export function mapAllowedKeys(keys: string[], payToOf: (id: string) => string | undefined, stored?: Pouch): string[] {
  const checkout = checkoutPayTo();
  if (stored && isAnyStore(stored) && keys.includes(checkout)) return [];
  const out: string[] = [];
  for (const key of keys) {
    if (key === checkout) {
      for (const id of stored?.allowedMerchantIds ?? []) if (id.startsWith(WEB_PREFIX)) out.push(id);
      continue;
    }
    const matches = merchants.filter((merchant) => payToOf(merchant.id) === key);
    if (matches.length !== 1) {
      console.warn(`[chain] Skipping unknown or ambiguous merchant address ${key}${stored ? ` on pouch ${stored.id}` : ""}.`);
      continue;
    }
    out.push(matches[0].id);
  }
  return [...new Set(out)];
}

/**
 * A preflight (simulation) failure that carries a program error means the program refused the
 * payment and nothing was broadcast. Map it to VaultRejected; any other error is rethrown unchanged
 * so recovery keeps treating it as an unresolved (retry-the-same-signature) failure.
 */
export function programRejection(e: unknown): never {
  try {
    mapError(e);
  } catch (mapped) {
    if (mapped instanceof VaultRejected && mapped.code !== "OrderAlreadyUsed") throw mapped;
  }
  throw e;
}

export class ChainVaultClient implements VaultClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly mint: PublicKey;
  private owner: Keypair;
  private agent: Keypair;
  private program: Program<SolpouchVault>;

  constructor(private payToOf: (merchantId: string) => string | undefined = () => undefined, private store?: Store) {
    const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    this.connection = new Connection(rpc, COMMITMENT);
    this.programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? "");
    this.mint = new PublicKey(process.env.TEST_USDC_MINT ?? "");
    this.owner = loadKeypair(process.env.OWNER_KEYPAIR_PATH ?? ".keys/owner.json");
    this.agent = loadKeypair(process.env.AGENT_KEYPAIR_PATH ?? ".keys/agent.json");
    const provider = new AnchorProvider(this.connection, new Wallet(this.owner), {
      commitment: COMMITMENT,
      preflightCommitment: COMMITMENT,
    });
    this.program = new Program<SolpouchVault>({ ...(idlJson as object), address: this.programId.toBase58() } as SolpouchVault, provider);
  }

  get authorizedOwner(): string { return this.owner.publicKey.toBase58(); }

  private pouchPda(id: string): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pouch"), this.owner.publicKey.toBuffer(), nameBytes(id)],
      this.programId,
    )[0];
  }
  private vaultPda(pouch: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("vault"), pouch.toBuffer()], this.programId)[0];
  }
  private receiptPda(pouch: PublicKey, order: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), pouch.toBuffer(), order],
      this.programId,
    )[0];
  }

  // web: entries and any-store resolve to the checkout wallet (see allow.ts)
  private merchantKeys(p: Pouch): PublicKey[] {
    return resolveMerchantKeys(allowedPayTos(p, this.payToOf));
  }

  get agentAddress(): string { return this.agent.publicKey.toBase58(); }

  /** Read-only: warn loudly when the agent key cannot pay for receipts. Sends nothing. */
  async checkAgentBalance(minSol = 0.05): Promise<number> {
    const lamports = await this.connection.getBalance(this.agent.publicKey, COMMITMENT);
    if (lamports < minSol * 1_000_000_000) {
      console.warn(`[startup] AGENT KEY LOW ON SOL: ${(lamports / 1e9).toFixed(4)} SOL. Each payment receipt costs about 0.0015 SOL. Fund the agent address ${this.agentAddress} with at least ${minSol} SOL or payments will fail.`);
    }
    return lamports;
  }

  private async assertDevnet() {
    if (await this.connection.getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
      throw new Error("Chain signing is restricted to Solana devnet");
    }
  }

  private async submit(id: string, kind: "pay" | "topup" | "withdraw", pouchId: string, build: () => Promise<Transaction>, signers: Keypair[]) {
    if (!this.store) throw new Error("A persistent operation store is required for chain payments");
    await this.assertDevnet();
    return recoverTransaction(this.store, id, {
      status: async (signature) => {
        const value = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
        return { confirmed: !!value && !value.err && (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized"), failed: !!value?.err, found: !!value };
      },
      blockHeight: () => this.connection.getBlockHeight(COMMITMENT),
      broadcast: async (bytes) => {
        try { return await this.connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0 }); } catch (e) { return programRejection(e); }
      },
      confirm: async (operation) => {
        const tx = Transaction.from(Buffer.from(operation.signedTransaction, "base64"));
        const result = await this.connection.confirmTransaction({ signature: operation.txSignature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: operation.lastValidBlockHeight }, COMMITMENT);
        return { failed: !!result.value.err };
      },
    }, async () => {
      const tx = await build();
      const latest = await this.connection.getLatestBlockhash(COMMITMENT);
      tx.feePayer = this.owner.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(...signers);
      return { id, kind, pouchId, txSignature: utils.bytes.bs58.encode(tx.signature!), signedTransaction: tx.serialize().toString("base64"), lastValidBlockHeight: latest.lastValidBlockHeight, createdAt: new Date().toISOString() };
    }, { kind, pouchId });
  }

  async createPouch(pouch: Pouch): Promise<{ address: string }> {
    const pda = this.pouchPda(pouch.id);
    if (await this.connection.getAccountInfo(pda, COMMITMENT)) return { address: pda.toBase58() };
    await this.assertDevnet();
    try {
      await this.program.methods
        .createPouch(
          Array.from(nameBytes(pouch.id)),
          this.agent.publicKey,
          new BN(pouch.maxPerOrder),
          new BN(pouch.dailyLimit),
          this.merchantKeys(pouch),
        )
        .accountsPartial({
          owner: this.owner.publicKey,
          mint: this.mint,
          pouch: pda,
          vault: this.vaultPda(pda),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: COMMITMENT });
    } catch (e) {
      mapError(e);
    }
    return { address: pda.toBase58() };
  }

  async topUp(pouchId: string, amount: Micros, operationId?: string): Promise<{ txSignature: string }> {
    if (!operationId) throw new Error("A saved top-up ID is required");
    const pouch = this.pouchPda(pouchId);
    const ownerAta = getAssociatedTokenAddressSync(this.mint, this.owner.publicKey);
    return this.submit(`topup:${operationId}`, "topup", pouchId, async () => {
      const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, ownerAta, this.owner.publicKey, this.mint));
      // Faucet is opt-in and minted funds plus deposit succeed or fail in ONE transaction.
      if (process.env.ENABLE_DEVNET_FAUCET === "true") tx.add(createMintToInstruction(this.mint, ownerAta, this.owner.publicKey, BigInt(amount)));
      tx.add(await this.program.methods.topUp(new BN(amount)).accountsPartial({ owner: this.owner.publicKey, pouch, vault: this.vaultPda(pouch), ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
      return tx;
    }, [this.owner]);
  }

  /** One transaction: vault -> owner ATA (program withdraw), then owner ATA -> toWallet's ATA (SPL transfer). */
  async withdraw(pouchId: string, amount: Micros, toWallet: string, operationId?: string): Promise<{ txSignature: string }> {
    if (!operationId) throw new Error("A saved withdrawal ID is required");
    const pouch = this.pouchPda(pouchId);
    const dest = new PublicKey(toWallet);
    const ownerAta = getAssociatedTokenAddressSync(this.mint, this.owner.publicKey);
    const destAta = getAssociatedTokenAddressSync(this.mint, dest, true);
    return this.submit(`withdraw:${operationId}`, "withdraw", pouchId, async () => {
      const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, ownerAta, this.owner.publicKey, this.mint));
      tx.add(await this.program.methods.withdraw(new BN(amount)).accountsPartial({ owner: this.owner.publicKey, pouch, vault: this.vaultPda(pouch), ownerToken: ownerAta, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
      if (!dest.equals(this.owner.publicKey)) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, destAta, dest, this.mint));
        tx.add(createTransferCheckedInstruction(ownerAta, this.mint, destAta, this.owner.publicKey, BigInt(amount), MINT_DECIMALS));
      }
      return tx;
    }, [this.owner]);
  }

  async pay(pouch: Pouch, merchantPayTo: string, amount: Micros, orderId: string): Promise<{ txSignature: string }> {
    const pda = this.pouchPda(pouch.id);
    const order = orderBytes(orderId);
    const receipt = this.receiptPda(pda, order);
    return this.submit(`pay:${orderId}`, "pay", pouch.id, async () => {
      // A historical receipt without a local journal cannot safely be reconstructed.
      if (await this.connection.getAccountInfo(receipt, COMMITMENT)) throw new Error("Existing payment receipt requires reconciliation");
      const merchant = new PublicKey(merchantPayTo);
      const merchantAta = getAssociatedTokenAddressSync(this.mint, merchant, true);
      return new Transaction()
        .add(createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, merchantAta, merchant, this.mint))
        .add(await this.program.methods.pay(new BN(amount), Array.from(order)).accountsPartial({ agent: this.agent.publicKey, pouch: pda, vault: this.vaultPda(pda), merchantToken: merchantAta, receipt, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction());
    }, [this.owner, this.agent]);
  }

  private async ownerOnly(id: string, method: "freeze" | "unfreeze"): Promise<{ txSignature: string }> {
    const pouch = this.pouchPda(id);
    await this.assertDevnet();
    try {
      const txSignature = await this.program.methods[method]()
        .accountsPartial({ owner: this.owner.publicKey, pouch })
        .rpc({ commitment: COMMITMENT });
      return { txSignature };
    } catch (e) {
      mapError(e);
    }
  }

  freeze(pouchId: string) {
    return this.ownerOnly(pouchId, "freeze");
  }
  unfreeze(pouchId: string) {
    return this.ownerOnly(pouchId, "unfreeze");
  }

  async getBalance(pouchId: string): Promise<{ balance: Micros; spentToday: Micros }> {
    const { balance, spentToday } = await this.getState(pouchId);
    return { balance, spentToday };
  }

  async getState(pouchId: string, stored?: Pouch): Promise<VaultState> {
    const pda = this.pouchPda(pouchId);
    const [acct, vault] = await Promise.all([
      this.program.account.pouch.fetch(pda, COMMITMENT),
      getAccount(this.connection, this.vaultPda(pda), COMMITMENT),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const expired = now - acct.dayStart.toNumber() >= DAY_SECONDS;
    if (!acct.owner.equals(this.owner.publicKey) || !acct.mint.equals(this.mint)) {
      throw new Error("Chain pouch owner or mint does not match the configured vault");
    }
    const allowedMerchantIds = mapAllowedKeys(acct.allowedMerchants.map((key) => key.toBase58()), this.payToOf, stored);
    const balance = Number(vault.amount);
    if (!Number.isSafeInteger(balance)) throw new Error("Chain balance exceeds supported precision");
    return { balance, spentToday: expired ? 0 : acct.spentToday.toNumber(), frozen: acct.frozen,
      maxPerOrder: acct.maxPerOrder.toNumber(), dailyLimit: acct.dailyLimit.toNumber(), allowedMerchantIds };
  }

  async updateRules(pouch: Pouch): Promise<{ txSignature: string }> {
    const pda = this.pouchPda(pouch.id);
    await this.assertDevnet();
    try {
      const txSignature = await this.program.methods
        .setRules(null, new BN(pouch.maxPerOrder), new BN(pouch.dailyLimit), this.merchantKeys(pouch))
        .accountsPartial({ owner: this.owner.publicKey, pouch: pda })
        .rpc({ commitment: COMMITMENT });
      return { txSignature };
    } catch (e) {
      mapError(e);
    }
  }
}

/** Startup reconciliation is read-only on chain. Missing accounts require explicit creation. */
export async function ensureOnChain(vault: ChainVaultClient, pouches: Pouch[]): Promise<Pouch[]> {
  const out: Pouch[] = [];
  const missing: string[] = [];
  for (const pouch of pouches) {
    try {
      const state = await vault.getState(pouch.id, pouch);
      out.push({ ...pouch, ...state });
    } catch {
      // One unreadable pouch must not stop the server: log it and keep the stored state.
      missing.push(pouch.id);
      console.warn(`[reconcile] Cannot read chain pouch ${pouch.id}; skipping it. Startup will not create or fund it.`);
    }
  }
  if (missing.length) console.warn(`[startup] WARNING: ${missing.length} pouch(es) are in the store but not readable on chain: ${missing.join(", ")}. Payments from them will fail until they are created on chain.`);
  return out;
}
