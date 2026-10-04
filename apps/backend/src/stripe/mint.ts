import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utils } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createMintToCheckedInstruction, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token';
import type { StripeFundingRequest } from './types.js';
import type { StripeRepository } from './repository.js';

export const DEMO_MINT = 'CiXLdY9HrDvBb7x3XfiqGjCHCrf31SmVDEQp3kJ6Z4Mf';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COMMITMENT = 'confirmed' as const;
export class MintPending extends Error {
  constructor(message = 'Payment received. The transfer is not confirmed yet; check this same request again.') { super(message); }
}

export function usdcMicros(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('Invalid stored test-USDC quote');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid stored test-USDC amount');
  return amount;
}

type MintInfo = { decimals: number; mintAuthority: PublicKey | null };
export interface MintOptions {
  connection?: Connection;
  authority?: Keypair;
  readMint?: (connection: Connection, mint: PublicKey) => Promise<MintInfo>;
}

/** Lazy: bad/missing mint configuration never prevents unrelated API startup.
 * The caller holds the repository's cross-process request lock for this entire operation.
 * Signed bytes are committed BEFORE broadcast; retries never mint a replacement transaction.
 */
export function createDevnetMint(options: MintOptions = {}) {
  return async (request: StripeFundingRequest, repository: StripeRepository): Promise<{ txSignature: string }> => {
    if (process.env.VAULT_MODE !== 'chain' || process.env.STRIPE_DEMO_MINT !== '1') throw new Error('Devnet test-USDC delivery is disabled');
    if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('Stripe test credentials are required for devnet delivery');
    if (request.status !== 'paid' && request.status !== 'confirmed') throw new Error('Payment has not been verified');
    const mint = new PublicKey(process.env.TEST_USDC_MINT || DEMO_MINT);
    if (mint.toBase58() !== DEMO_MINT) throw new Error('Stripe delivery only supports the configured Solpouch devnet test mint');
    const connection = options.connection ?? new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', {
      commitment: COMMITMENT,
      confirmTransactionInitialTimeout: 20_000,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) }),
    });
    if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error('Stripe minting requires the Solana devnet network');
    const wallet = new PublicKey(request.wallet);
    if (!PublicKey.isOnCurve(wallet.toBytes()) || wallet.toBase58() !== request.wallet) throw new Error('Invalid destination wallet');
    const amount = usdcMicros(request.usdcAmount);
    let record = await repository.get(request.id);
    if (!record || record.wallet !== request.wallet || record.usdcAmount !== request.usdcAmount || !['paid','confirmed'].includes(record.status)) throw new Error('Funding request changed before delivery');
    let operation = record.mintOperation;
    if (!operation) {
      const path = process.env.STRIPE_MINT_KEYPAIR_PATH || process.env.OWNER_KEYPAIR_PATH || '.keys/owner.json';
      const authority = options.authority ?? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(isAbsolute(path) ? path : resolve(ROOT, path), 'utf8'))));
      const info = await (options.readMint ?? ((c, m) => getMint(c, m, COMMITMENT)))(connection, mint);
      if (info.decimals !== 6 || !info.mintAuthority?.equals(authority.publicKey)) throw new Error('Devnet mint authority or token decimals do not match');
      const ata = getAssociatedTokenAddressSync(mint, wallet);
      const tx = new Transaction().add(
        new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`solpouch:stripe:${request.id}`) }),
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, wallet, mint),
        createMintToCheckedInstruction(mint, ata, authority.publicKey, amount, 6),
      );
      const block = await connection.getLatestBlockhash(COMMITMENT);
      tx.feePayer = authority.publicKey; tx.recentBlockhash = block.blockhash;
      tx.sign(authority);
      const prepared = { requestId: request.id, wallet: request.wallet, mint: mint.toBase58(), amountMicros: amount.toString(), signature: utils.bytes.bs58.encode(tx.signature!), rawTransaction: tx.serialize().toString('base64'), lastValidBlockHeight: block.lastValidBlockHeight };
      record = await repository.update(request.id, latest => {
        if (latest.wallet !== request.wallet || latest.usdcAmount !== request.usdcAmount || !['paid','confirmed'].includes(latest.status)) throw new Error('Funding request changed before delivery');
        return latest.mintOperation ? latest : { ...latest, mintOperation: prepared };
      });
      operation = record.mintOperation;
    }
    if (!operation || operation.requestId !== request.id || operation.wallet !== request.wallet || operation.mint !== mint.toBase58() || operation.amountMicros !== amount.toString()) throw new Error('Mint journal does not match the funding request');
    const bytes = Buffer.from(operation.rawTransaction, 'base64');
    const signed = Transaction.from(bytes);
    if (!signed.verifySignatures() || !signed.signature || utils.bytes.bs58.encode(signed.signature) !== operation.signature || !signed.recentBlockhash) throw new Error('Invalid signed mint journal');
    const status = (await connection.getSignatureStatuses([operation.signature], { searchTransactionHistory: true })).value[0];
    const durable = status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
    if (durable && !status?.err) return { txSignature: operation.signature };
    if (durable && status?.err) throw new MintPending('Payment received, but its transfer failed. It needs review; no replacement transfer was sent.');
    if (await connection.getBlockHeight(COMMITMENT) > operation.lastValidBlockHeight) throw new MintPending('Payment received. The transfer expired without a confirmed result and needs review; no replacement was sent.');
    try {
      const returned = await connection.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 0 });
      if (returned !== operation.signature) throw new Error('RPC returned a different transaction signature');
      const result = await connection.confirmTransaction({ signature: operation.signature, blockhash: signed.recentBlockhash, lastValidBlockHeight: operation.lastValidBlockHeight, abortSignal: AbortSignal.timeout(20_000) }, COMMITMENT);
      if (result.value.err) throw new MintPending('Payment received, but its transfer failed. It needs review; no replacement transfer was sent.');
      return { txSignature: operation.signature };
    } catch (error) {
      if (error instanceof MintPending) throw error;
      throw new MintPending();
    }
  };
}
