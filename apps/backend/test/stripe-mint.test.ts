import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { utils } from '@coral-xyz/anchor';
import { createDevnetMint, DEMO_MINT, MintPending } from '../src/stripe/mint.js';
import { MemoryStripeRepository, type StripeFundingRequest } from '../src/stripe/repository.js';

const authority = Keypair.generate();
const wallet = Keypair.generate().publicKey.toBase58();
const fixture = (id = 'funding-1'): StripeFundingRequest => ({ id, provider:'stripe', owner:'mint@example.com', idempotencyKey:id, wallet, amountCad:'25.00', amountCents:2500, usdPerCad:'0.73', usdcMicros:18250000, usdcAmount:'18.250000', status:'paid', createdAt:new Date().toISOString() });
function setup() {
  const repo = new MemoryStripeRepository();
  let landed = false;
  const signatures: string[] = [];
  const rpc = {
    getGenesisHash: vi.fn(async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
    getLatestBlockhash: vi.fn(async () => ({ blockhash:Keypair.generate().publicKey.toBase58(), lastValidBlockHeight:100 })),
    getSignatureStatuses: vi.fn(async () => ({ value:[landed ? { err:null, confirmationStatus:'confirmed' } : null] })),
    getBlockHeight: vi.fn(async () => 10),
    sendRawTransaction: vi.fn(async (raw:Uint8Array) => { const tx=Transaction.from(raw); const signature=utils.bytes.bs58.encode(tx.signature!); signatures.push(signature); landed=true; return signature; }),
    confirmTransaction: vi.fn(async () => ({value:{err:null}})),
  };
  const readMint = vi.fn(async () => ({ decimals:6, mintAuthority:authority.publicKey }));
  const mint=createDevnetMint({connection:rpc as unknown as Connection,authority,readMint});
  return { repo, rpc, mint, signatures, readMint };
}

describe('Stripe devnet mint journal',()=>{
  beforeEach(()=>{vi.stubEnv('VAULT_MODE','chain');vi.stubEnv('STRIPE_DEMO_MINT','1');vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture');vi.stubEnv('TEST_USDC_MINT',DEMO_MINT);});
  afterEach(()=>vi.unstubAllEnvs());
  it('journals signed amount, destination and unique memo before broadcast; replay does not resend',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    f.rpc.sendRawTransaction.mockImplementationOnce(async raw=>{
      const saved=await f.repo.get(request.id);expect(saved?.mintOperation?.rawTransaction).toBe(Buffer.from(raw).toString('base64'));
      const tx=Transaction.from(raw);expect(tx.instructions[0].data.toString()).toBe('solpouch:stripe:funding-1');
      expect(tx.instructions[2].data.readBigUInt64LE(1)).toBe(18250000n);
      return utils.bytes.bs58.encode(tx.signature!);
    });
    const first=await f.mint(request,f.repo);
    f.rpc.getSignatureStatuses.mockResolvedValue({value:[{err:null,confirmationStatus:'confirmed'}]});
    expect(await f.mint(request,f.repo)).toEqual(first);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(f.rpc.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });
  it('cannot broadcast when journal persistence fails',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    vi.spyOn(f.repo,'update').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.mint(request,f.repo)).rejects.toThrow('database unavailable');
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('recovers an accepted transfer after timeout without minting a second time',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    f.rpc.confirmTransaction.mockRejectedValueOnce(new Error('RPC timeout'));
    await expect(f.mint(request,f.repo)).rejects.toBeInstanceOf(MintPending);
    const result=await f.mint(request,f.repo);
    expect(result.txSignature).toBe(f.signatures[0]);expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('expired missing history never creates replacement signed bytes',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    f.rpc.sendRawTransaction.mockRejectedValue(new Error('lost response'));
    await expect(f.mint(request,f.repo)).rejects.toBeInstanceOf(MintPending);
    const first=(await f.repo.get(request.id))!.mintOperation;
    f.rpc.getBlockHeight.mockResolvedValue(101);
    await expect(f.mint(request,f.repo)).rejects.toThrow('expired');
    expect((await f.repo.get(request.id))!.mintOperation).toEqual(first);
    expect(f.rpc.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });
  it('different request IDs produce different signatures even under one blockhash',async()=>{
    const f=setup();f.rpc.getLatestBlockhash.mockResolvedValue({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100});
    f.rpc.getSignatureStatuses.mockResolvedValue({value:[null]} as never);
    const a=await f.mint(await f.repo.create(fixture('a')),f.repo);
    const b=await f.mint(await f.repo.create(fixture('b')),f.repo);
    expect(a.txSignature).not.toBe(b.txSignature);
  });
  it('refuses live keys, disabled delivery and a non-devnet RPC before writing',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    vi.stubEnv('STRIPE_SECRET_KEY','sk_live_fixture');await expect(f.mint(request,f.repo)).rejects.toThrow('test credentials');
    vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture');vi.stubEnv('STRIPE_DEMO_MINT','0');await expect(f.mint(request,f.repo)).rejects.toThrow('disabled');
    vi.stubEnv('STRIPE_DEMO_MINT','1');f.rpc.getGenesisHash.mockResolvedValue('mainnet');await expect(f.mint(request,f.repo)).rejects.toThrow('devnet network');
    expect((await f.repo.get(request.id))!.mintOperation).toBeUndefined();expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it('checks mint authority and refuses tampered journal context',async()=>{
    const f=setup(), request=await f.repo.create(fixture());
    f.readMint.mockResolvedValueOnce({decimals:6,mintAuthority:Keypair.generate().publicKey});
    await expect(f.mint(request,f.repo)).rejects.toThrow('authority');
    await f.mint(request,f.repo);
    await f.repo.update(request.id,r=>({...r,mintOperation:{...r.mintOperation!,wallet:Keypair.generate().publicKey.toBase58()}}));
    await expect(f.mint(request,f.repo)).rejects.toThrow('journal does not match');
  });
});
