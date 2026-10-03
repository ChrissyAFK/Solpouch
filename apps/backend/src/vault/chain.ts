import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Micros, Pouch } from "@solpouch/shared";
import { VaultRejected, type VaultClient, type VaultRejectCode } from "./types.js";
import idlJson from "./idl/solpouch_vault.json" with { type: "json" };
import type { SolpouchVault } from "./idl/solpouch_vault.js";

// apps/backend/src/vault -> repo root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DAY_SECONDS = 86_400;
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

function mapError(e: unknown): never {
  if (e instanceof VaultRejected) throw e;
  const anyE = e as { error?: { errorCode?: { code?: string } }; message?: string; logs?: string[] };
  const code = anyE?.error?.errorCode?.code;
  if (code && PROGRAM_ERRORS.has(code)) throw new VaultRejected(code as VaultRejectCode);
  const text = `${anyE?.message ?? ""} ${(anyE?.logs ?? []).join(" ")}`;
  for (const name of PROGRAM_ERRORS) {
    if (text.includes(`Error Code: ${name}`)) throw new VaultRejected(name as VaultRejectCode);
  }
  if (/already in use/i.test(text)) throw new VaultRejected("OrderAlreadyUsed");
  throw e;
}

export class ChainVaultClient implements VaultClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly mint: PublicKey;
  private owner: Keypair;
  private agent: Keypair;
  private program: Program<SolpouchVault>;

  constructor(private payToOf: (merchantId: string) => string | undefined = () => undefined) {
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

  private merchantKeys(p: Pouch): PublicKey[] {
    return p.allowedMerchantIds
      .map((id) => this.payToOf(id))
      .filter((s): s is string => !!s)
      .map((s) => new PublicKey(s));
  }

  private async sendIxs(ixs: Parameters<Transaction["add"]>, signers: Keypair[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.connection, tx, signers, { commitment: COMMITMENT });
  }

  async createPouch(pouch: Pouch): Promise<{ address: string }> {
    const pda = this.pouchPda(pouch.id);
    if (await this.connection.getAccountInfo(pda, COMMITMENT)) return { address: pda.toBase58() };
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

  async topUp(pouchId: string, amount: Micros): Promise<{ txSignature: string }> {
    const pouch = this.pouchPda(pouchId);
    const ownerAta = getAssociatedTokenAddressSync(this.mint, this.owner.publicKey);
    await this.sendIxs(
      [
        createAssociatedTokenAccountIdempotentInstruction(
          this.owner.publicKey, ownerAta, this.owner.publicKey, this.mint),
        createMintToInstruction(this.mint, ownerAta, this.owner.publicKey, BigInt(amount)),
      ],
      [this.owner],
    );
    try {
      const txSignature = await this.program.methods
        .topUp(new BN(amount))
        .accountsPartial({
          owner: this.owner.publicKey,
          pouch,
          vault: this.vaultPda(pouch),
          ownerToken: ownerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ commitment: COMMITMENT });
      return { txSignature };
    } catch (e) {
      mapError(e);
    }
  }

  async pay(
    pouch: Pouch,
    merchantPayTo: string,
    amount: Micros,
    orderId: string,
  ): Promise<{ txSignature: string }> {
    const pda = this.pouchPda(pouch.id);
    const order = orderBytes(orderId);
    const receipt = this.receiptPda(pda, order);
    if (await this.connection.getAccountInfo(receipt, COMMITMENT)) throw new VaultRejected("OrderAlreadyUsed");

    const merchant = new PublicKey(merchantPayTo);
    const merchantAta = getAssociatedTokenAddressSync(this.mint, merchant, true);
    await this.sendIxs(
      [createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, merchantAta, merchant, this.mint)],
      [this.owner],
    );
    try {
      const txSignature = await this.program.methods
        .pay(new BN(amount), Array.from(order))
        .accountsPartial({
          agent: this.agent.publicKey,
          pouch: pda,
          vault: this.vaultPda(pda),
          merchantToken: merchantAta,
          receipt,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.agent])
        .rpc({ commitment: COMMITMENT });
      return { txSignature };
    } catch (e) {
      mapError(e);
    }
  }

  private async ownerOnly(id: string, method: "freeze" | "unfreeze"): Promise<{ txSignature: string }> {
    const pouch = this.pouchPda(id);
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
    const pda = this.pouchPda(pouchId);
    const [acct, vault] = await Promise.all([
      this.program.account.pouch.fetch(pda, COMMITMENT),
      getAccount(this.connection, this.vaultPda(pda), COMMITMENT),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const expired = now - acct.dayStart.toNumber() >= DAY_SECONDS;
    return { balance: Number(vault.amount), spentToday: expired ? 0 : acct.spentToday.toNumber() };
  }

  async updateRules(pouch: Pouch): Promise<{ txSignature: string }> {
    const pda = this.pouchPda(pouch.id);
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

/** For each pouch: create on chain if missing, fund the vault up to pouch.balance, return with `address` set. */
export async function ensureOnChain(vault: ChainVaultClient, pouches: Pouch[]): Promise<Pouch[]> {
  const out: Pouch[] = [];
  for (const p of pouches) {
    const { address } = await vault.createPouch(p);
    const { balance } = await vault.getBalance(p.id);
    if (balance < p.balance) await vault.topUp(p.id, p.balance - balance);
    out.push({ ...p, address });
  }
  return out;
}
