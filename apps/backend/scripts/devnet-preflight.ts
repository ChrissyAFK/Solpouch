/** Read-only by default. --request-airdrop asks only for devnet test SOL, never sends funds. */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const dir = process.env.DEVNET_TEST_DIR;
if (!dir) throw new Error('Set DEVNET_TEST_DIR to an isolated directory outside the repository. No existing owner key is used.');
await mkdir(dir, { recursive: true, mode: 0o700 });
const keyPath = resolve(dir, 'owner.json');
let owner: Keypair;
try { owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(keyPath, 'utf8')))); }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  owner = Keypair.generate(); await writeFile(keyPath, JSON.stringify([...owner.secretKey]), { mode: 0o600, flag: 'wx' });
}
const connection = new Connection('https://api.devnet.solana.com', {
  commitment: 'confirmed', disableRetryOnRateLimit: true,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
});
const genesis = await connection.getGenesisHash();
if (genesis !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Unexpected network: refusing any faucet request');
const programId = process.env.DEVNET_TEST_PROGRAM_ID ?? 'AqixXTfd8n914z7QCsNmBuZcFbDsitbGrBfCHStmJT8F';
const program = await connection.getAccountInfo(new PublicKey(programId));
const balance = await connection.getBalance(owner.publicKey);
const report: Record<string, unknown> = { checkedAt: new Date().toISOString(), genesis, programId, programExecutable: program?.executable ?? false, wallet: owner.publicKey.toBase58(), lamports: balance, fundedTransactionTests: 'not run' };
if (!program?.executable) throw new Error('Expected devnet program is not executable');
if (process.argv.includes('--request-airdrop') && balance < LAMPORTS_PER_SOL / 10) {
  try { report.airdropSignature = await connection.requestAirdrop(owner.publicKey, LAMPORTS_PER_SOL); report.airdropStatus = 'submitted, confirmation still required'; }
  catch { report.airdropStatus = 'failed; fund this isolated test wallet with devnet SOL before running transaction tests'; process.exitCode = 2; }
}
await writeFile(resolve(dir, 'preflight.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
