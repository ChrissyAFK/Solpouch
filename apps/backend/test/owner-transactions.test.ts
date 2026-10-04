import { BorshAccountsCoder, BN, type Idl } from "@coral-xyz/anchor";
import { AccountLayout,TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair,PublicKey,Transaction,type Connection } from "@solana/web3.js";
import { describe,it,expect,vi } from "vitest";
import idl from "../src/vault/idl/solpouch_vault.json" with { type:"json" };
import { prepareOwnerTransfer } from "../src/vault/ownerTransactions.js";

async function fixture() {
 const owner=Keypair.generate().publicKey, mint=Keypair.generate().publicKey, program=new PublicKey(idl.address);
 const name=Buffer.alloc(32);name.write("owner-test");
 const [pouch,bump]=PublicKey.findProgramAddressSync([Buffer.from("pouch"),owner.toBuffer(),name],program);
 const [,vaultBump]=PublicKey.findProgramAddressSync([Buffer.from("vault"),pouch.toBuffer()],program);
 const data=await new BorshAccountsCoder(idl as Idl).encode("Pouch",{owner,agent:owner,mint,name:[...name],allowed_merchants:[],max_per_order:new BN(1),daily_limit:new BN(1),spent_today:new BN(0),day_start:new BN(0),frozen:false,bump,vault_bump:vaultBump});
 const info=(data:Buffer,owner:PublicKey)=>({data,owner,lamports:1,executable:false,rentEpoch:0});
 function token(authority:PublicKey) {
  const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:authority,amount:5_000_000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return info(data,TOKEN_PROGRAM_ID);
 }
 const rpc={getGenesisHash:vi.fn(async()=>"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),getAccountInfo:vi.fn(async()=>info(data,program)),getMultipleAccountsInfo:vi.fn(async()=>[token(owner),token(pouch)]),getLatestBlockhash:vi.fn(async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100})),getFeeForMessage:vi.fn(async()=>({value:5000})),getMinimumBalanceForRentExemption:vi.fn(async()=>2_039_280),getBalance:vi.fn(async()=>10_000_000)};
 return {rpc,connection:rpc as unknown as Connection,input:{owner,pouch,program,mint,kind:"deposit" as const,amountMicros:1_000_000,network:"devnet" as const},token};
}
describe("unsigned owner transfer preparation",()=>{
 it("builds a deposit requiring only the owner's signature, with an explicit SOL fee",async()=>{
  const f=await fixture();const prepared=await prepareOwnerTransfer(f.connection,f.input);const tx=Transaction.from(Buffer.from(prepared.transaction,"base64"));
  expect(tx.signatures).toHaveLength(1);expect(tx.signatures[0].publicKey.equals(f.input.owner)).toBe(true);expect(tx.signatures[0].signature).toBeNull();expect(prepared.feeLamports).toBe(5000);expect(prepared.lastValidBlockHeight).toBe(100);
  expect(tx.instructions[0].data.subarray(8).readBigUInt64LE()).toBe(1_000_000n);
 });
 it("builds withdrawals only to the owner's token account and budgets rent",async()=>{
  const f=await fixture();f.rpc.getMultipleAccountsInfo.mockResolvedValue([null as any,f.token(f.input.pouch)]);
  const prepared=await prepareOwnerTransfer(f.connection,{...f.input,kind:"withdraw"});const tx=Transaction.from(Buffer.from(prepared.transaction,"base64"));
  expect(tx.instructions).toHaveLength(2);expect(prepared.rentLamports).toBe(2_039_280);expect(tx.signatures[0].signature).toBeNull();
 });
 it("rejects wrong wallet and wrong mint",async()=>{
  const f=await fixture();await expect(prepareOwnerTransfer(f.connection,{...f.input,owner:Keypair.generate().publicKey})).rejects.toThrow("does not own");
  await expect(prepareOwnerTransfer(f.connection,{...f.input,mint:Keypair.generate().publicKey})).rejects.toThrow("mint does not match");
 });
 it("rejects mainnet and mismatched RPC before account work",async()=>{
  const f=await fixture();await expect(prepareOwnerTransfer(f.connection,{...f.input,network:"mainnet-beta"})).rejects.toThrow("not enabled");expect(f.rpc.getAccountInfo).not.toHaveBeenCalled();
  f.rpc.getGenesisHash.mockResolvedValue("mainnet");await expect(prepareOwnerTransfer(f.connection,f.input)).rejects.toThrow("does not match devnet");
 });
 it("rejects invalid amounts, insufficient USDC and insufficient fee balance",async()=>{
  const f=await fixture();for(const amountMicros of [0,-1,NaN,Infinity,1.2,Number.MAX_SAFE_INTEGER+1])await expect(prepareOwnerTransfer(f.connection,{...f.input,amountMicros})).rejects.toThrow("positive amount");
  await expect(prepareOwnerTransfer(f.connection,{...f.input,amountMicros:6_000_000})).rejects.toThrow("Not enough USDC");f.rpc.getBalance.mockResolvedValue(0);await expect(prepareOwnerTransfer(f.connection,f.input)).rejects.toThrow("more SOL");
 });
 it("rejects account data supplied by a different program",async()=>{
  const f=await fixture();const info=await f.rpc.getAccountInfo();f.rpc.getAccountInfo.mockResolvedValue({...info,owner:Keypair.generate().publicKey});await expect(prepareOwnerTransfer(f.connection,f.input)).rejects.toThrow("configured program");
 });
});
