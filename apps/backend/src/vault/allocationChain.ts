import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { loadKeypair } from "./chain.js";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MINT_DECIMALS = 6;

export const allocationMemo = (allocationId: string) => `solpouch:allocation:${allocationId}`;

export interface BuiltTransfer { transaction: string; lastValidBlockHeight: number }
export type TransferCheck = { ok: true } | { ok: false; reason: string };

/** Chain access for wallet-to-pouch allocations. Real impl uses RPC; tests inject a fake. */
export interface AllocationChain {
  /** Unsigned transaction (base64): user wallet pays `amount` micros of test-USDC to the vault owner. */
  buildTransfer(args: { wallet: string; amount: number; allocationId: string }): Promise<BuiltTransfer>;
  /** Check a confirmed transaction moved exactly `amount` from `wallet` to the vault owner with the allocation memo. */
  verifyTransfer(args: { signature: string; wallet: string; amount: number; allocationId: string }): Promise<TransferCheck>;
}

export function createRpcAllocationChain(): AllocationChain {
  const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
  const mint = new PublicKey(process.env.TEST_USDC_MINT ?? "");
  const owner = loadKeypair(process.env.OWNER_KEYPAIR_PATH ?? ".keys/owner.json").publicKey;
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);

  return {
    async buildTransfer({ wallet, amount, allocationId }) {
      const user = new PublicKey(wallet);
      const userAta = getAssociatedTokenAddressSync(mint, user, true);
      const latest = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: user, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight })
        .add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(allocationMemo(allocationId), "utf8") }))
        .add(createAssociatedTokenAccountIdempotentInstruction(user, ownerAta, owner, mint))
        .add(createTransferCheckedInstruction(userAta, mint, ownerAta, user, BigInt(amount), MINT_DECIMALS));
      return { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), lastValidBlockHeight: latest.lastValidBlockHeight };
    },

    async verifyTransfer({ signature, wallet, amount, allocationId }) {
      const tx = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) return { ok: false, reason: "Transaction not found or not confirmed yet" };
      if (!tx.meta || tx.meta.err) return { ok: false, reason: "Transaction failed on chain" };
      const memo = allocationMemo(allocationId);
      const hasMemo = tx.transaction.message.instructions.some((ix) => ix.programId.equals(MEMO_PROGRAM) && "parsed" in ix && ix.parsed === memo);
      if (!hasMemo) return { ok: false, reason: "Transaction does not carry this allocation's memo" };
      const balance = (list: typeof tx.meta.preTokenBalances, who: string) => (list ?? [])
        .filter((b) => b.mint === mint.toBase58() && b.owner === who)
        .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
      const pre = tx.meta.preTokenBalances, post = tx.meta.postTokenBalances;
      const spent = balance(pre, wallet) - balance(post, wallet);
      const received = balance(post, owner.toBase58()) - balance(pre, owner.toBase58());
      if (spent !== BigInt(amount) || received !== BigInt(amount)) return { ok: false, reason: "Transferred amount does not match the allocation" };
      return { ok: true };
    },
  };
}
