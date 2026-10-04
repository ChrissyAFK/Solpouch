import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { HttpError } from '../services/orders.js';
import type { Store } from '../store/types.js';
import type { FundingRepository } from './repository.js';
import type { FundingRequest, FundingStatus } from './types.js';
import { createHostedSession, requireTransak, type TransakConfig, type TransakEvent } from './transak.js';
import { usdcMicros } from './verification.js';
export interface StartFunding {country:'US'|'CA';direction:'BUY'|'SELL';amount:string;idempotencyKey:string;}
export async function startFunding(repo:FundingRepository,store:Pick<Store,'getUser'>,owner:string,input:StartFunding,ip:string,config:TransakConfig,transport:typeof fetch=fetch) {
  requireTransak(config);
  if(!config.capabilities.has(`${input.country}:${input.direction}`)) throw new HttpError(503,'This funding route has not been enabled for your region.');
  const wallet=(await store.getUser(owner))?.wallet;
  if(!wallet) throw new HttpError(409,'Link and verify your Solana wallet before using bank funding.');
  try {new PublicKey(wallet);} catch {throw new HttpError(409,'Your linked wallet is invalid. Link it again.');}
  const now=new Date().toISOString();
  const candidate:FundingRequest={...input,id:randomUUID(),owner,wallet,currency:input.country==='US'?'USD':'CAD',environment:'staging',status:'created',createdAt:now,updatedAt:now};
  const saved=await repo.create(candidate);
  if(!saved.created) {
    const prior=saved.request;
    if(prior.country!==input.country || prior.direction!==input.direction || prior.amount!==input.amount || prior.wallet!==wallet) throw new HttpError(409,'This request key was already used with different payment details.');
    return {request:prior};
  }
  // Persist before external work. A lost response can never silently create a second payment.
  try {
    const widgetUrl=await createHostedSession(saved.request,ip,config,transport);
    const request=await repo.update(saved.request.id,r=>r.status==='created'?{...r,status:'session_ready',updatedAt:new Date().toISOString()}:r);
    return {request,widgetUrl};
  } catch(e) {
    await repo.update(saved.request.id,r=>r.status==='created'?{...r,status:'session_uncertain',message:'Checkout could not be delivered. Do not repeat a bank payment; check its status or contact support.',updatedAt:new Date().toISOString()}:r);
    throw e;
  }
}
const ranks:Record<FundingStatus,number>={created:0,session_ready:1,session_uncertain:1,processing:2,failed:3,cancelled:3,provider_completed:4,sandbox_completed:5,confirmed:5,refunded:6};
export async function applyFundingEvent(repo:FundingRepository,event:TransakEvent) {
  const e=event.webhookData;
  if(!await repo.get(e.partnerOrderId)) throw new HttpError(404,'Funding request not found.');
  return repo.update(e.partnerOrderId,r=>{
    if((r.direction==='BUY' && r.wallet!==e.walletAddress) || r.currency!==e.fiatCurrency || r.country!==e.countryCode || r.direction!==e.isBuyOrSell || (r.providerOrderId && r.providerOrderId!==e.id)) throw new HttpError(400,'Funding notification does not match its request.');
    const reported=r.direction==='BUY'?e.fiatAmount:e.cryptoAmount;
    if(!reported || usdcMicros(reported)!==usdcMicros(r.amount)) throw new HttpError(400,'Funding amount does not match its request.');
    let status:FundingStatus;
    switch(e.status) {
      case 'COMPLETED': status='sandbox_completed'; break;
      case 'REFUNDED': status='refunded';break;
      case 'FAILED':case 'EXPIRED':status='failed';break;
      case 'CANCELLED':status='cancelled';break;
      case 'AWAITING_PAYMENT_FROM_USER':case 'PAYMENT_DONE_MARKED_BY_USER':case 'PROCESSING':case 'PENDING_DELIVERY_FROM_TRANSAK':status='processing';break;
      default:throw new HttpError(400,'Unsupported funding status.');
    }
    if(ranks[status]<ranks[r.status]) return r;
    if(ranks[r.status]>=5 && r.txSignature && e.transactionHash && r.txSignature!==e.transactionHash) throw new HttpError(400,'Funding receipt changed unexpectedly.');
    if(ranks[r.status]>=5 && r.cryptoAmount && e.cryptoAmount && usdcMicros(r.cryptoAmount)!==usdcMicros(e.cryptoAmount)) throw new HttpError(400,'Funding delivered amount changed unexpectedly.');
    // No funds are ever credited here. Staging completion is explicitly simulated.
    return {...r,providerOrderId:e.id,status,cryptoAmount:e.cryptoAmount??r.cryptoAmount,txSignature:e.transactionHash??r.txSignature,message:status==='sandbox_completed'?'Sandbox provider completed. No real money or pouch balance changed.':r.message,updatedAt:new Date().toISOString()};
  });
}
