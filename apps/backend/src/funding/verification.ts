import { Connection, PublicKey } from '@solana/web3.js';
/** Read-only receipt verification. Never signs or sends a transaction. */
export const MAINNET_USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function usdcMicros(amount:string):bigint {
  if(!/^\d+(\.\d{1,6})?$/.test(amount)) throw new Error('Invalid USDC amount');
  const [whole,fraction='']=amount.split('.');
  return BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,'0'));
}
export async function verifyMainnetUsdcReceipt(connection:Pick<Connection,'getGenesisHash'|'getParsedTransaction'>,signature:string,wallet:string,amount:string):Promise<boolean> {
  new PublicKey(wallet);
  if(!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) return false;
  const expected=usdcMicros(amount); if(expected<=0n) return false;
  if(await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('Mainnet receipt verification requires a mainnet RPC');
  const tx=await connection.getParsedTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  if(!tx?.meta || tx.meta.err) return false;
  const before=new Map((tx.meta.preTokenBalances??[]).filter(b=>b.owner===wallet && b.mint===MAINNET_USDC_MINT && b.uiTokenAmount.decimals===6).map(b=>[b.accountIndex,BigInt(b.uiTokenAmount.amount)]));
  const after=(tx.meta.postTokenBalances??[]).filter(b=>b.owner===wallet && b.mint===MAINNET_USDC_MINT && b.uiTokenAmount.decimals===6);
  let net=0n;
  for(const b of after) { net+=BigInt(b.uiTokenAmount.amount)-(before.get(b.accountIndex)??0n); before.delete(b.accountIndex); }
  for(const removed of before.values()) net-=removed;
  return net===expected;
}
