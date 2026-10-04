/** Unsigned owner-only transactions. Not mounted in the API until the wallet
 * submission/reconciliation path and deployed program have been verified.
 * Never uses a server owner key and never broadcasts. */
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, Transaction, TransactionInstruction, type Connection } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import idl from "./idl/solpouch_vault.json" with { type: "json" };

export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const coder = new BorshAccountsCoder(idl as Idl);

type OwnerTransfer = {
  /** Must come from the account's verified linked wallet, not a request body. */
  owner: PublicKey;
  pouch: PublicKey;
  program: PublicKey;
  mint: PublicKey;
  kind: "deposit" | "withdraw";
  amountMicros: number;
  network: "devnet" | "mainnet-beta";
};
export async function prepareOwnerTransfer(connection: Connection, input: OwnerTransfer) {
  if (input.network !== "devnet") throw new Error("Mainnet pouch transfers are not enabled; program review and wallet submission verification are required");
  if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) throw new Error("Enter a positive amount in whole micro-USDC");
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw new Error("The RPC network does not match devnet");
  const info = await connection.getAccountInfo(input.pouch, "confirmed");
  if (!info || !info.owner.equals(input.program)) throw new Error("Pouch does not belong to the configured program");
  const pouch = coder.decode("Pouch", info.data) as {owner:PublicKey;mint:PublicKey;name:number[];bump:number;vault_bump:number};
  if (!pouch.owner.equals(input.owner)) throw new Error("Linked wallet does not own this pouch");
  if (!pouch.mint.equals(input.mint)) throw new Error("Pouch token mint does not match");
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("pouch"),input.owner.toBuffer(),Buffer.from(pouch.name)], input.program);
  if (!pda.equals(input.pouch) || bump !== pouch.bump) throw new Error("Invalid pouch address");
  const [vault, vaultBump] = PublicKey.findProgramAddressSync([Buffer.from("vault"),input.pouch.toBuffer()], input.program);
  if (vaultBump !== pouch.vault_bump) throw new Error("Invalid vault address");
  const ownerToken = getAssociatedTokenAddressSync(input.mint,input.owner);
  const [ownerInfo,vaultInfo] = await connection.getMultipleAccountsInfo([ownerToken,vault],"confirmed");
  if (!vaultInfo) throw new Error("Pouch vault is missing");
  const vaultAccount = unpackAccount(vault,vaultInfo,TOKEN_PROGRAM_ID);
  if (!vaultAccount.owner.equals(input.pouch) || !vaultAccount.mint.equals(input.mint) || !vaultAccount.isInitialized || vaultAccount.isFrozen) throw new Error("Invalid pouch token account");
  const ownerAccount = ownerInfo ? unpackAccount(ownerToken,ownerInfo,TOKEN_PROGRAM_ID) : undefined;
  if (ownerAccount && (!ownerAccount.owner.equals(input.owner) || !ownerAccount.mint.equals(input.mint) || !ownerAccount.isInitialized || ownerAccount.isFrozen)) throw new Error("Invalid owner token account");
  const available = input.kind === "deposit" ? ownerAccount?.amount ?? 0n : vaultAccount.amount;
  if (available < BigInt(input.amountMicros)) throw new Error("Not enough USDC for this transfer");
  const tx = new Transaction();
  if (!ownerInfo) tx.add(createAssociatedTokenAccountIdempotentInstruction(input.owner,ownerToken,input.owner,input.mint));
  const instruction = idl.instructions.find(i=>i.name === (input.kind === "deposit" ? "top_up" : "withdraw"))!;
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(input.amountMicros));
  tx.add(new TransactionInstruction({programId:input.program,data:Buffer.concat([Buffer.from(instruction.discriminator),amount]),keys:[
    {pubkey:input.owner,isSigner:true,isWritable:false}, {pubkey:input.pouch,isSigner:false,isWritable:false},
    {pubkey:vault,isSigner:false,isWritable:true}, {pubkey:ownerToken,isSigner:false,isWritable:true},
    {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
  ]}));
  const block = await connection.getLatestBlockhash("confirmed");
  tx.feePayer=input.owner; tx.recentBlockhash=block.blockhash;
  const fee = (await connection.getFeeForMessage(tx.compileMessage(),"confirmed")).value;
  if (fee === null) throw new Error("Could not estimate the transaction fee; retry later");
  const rent = ownerInfo ? 0 : await connection.getMinimumBalanceForRentExemption(165,"confirmed");
  if (await connection.getBalance(input.owner,"confirmed") < fee+rent) throw new Error("Your wallet needs more SOL for the transaction fee and token account rent");
  return {transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString("base64"),lastValidBlockHeight:block.lastValidBlockHeight,feeLamports:fee,rentLamports:rent,network:input.network,kind:input.kind,amountMicros:input.amountMicros};
}
