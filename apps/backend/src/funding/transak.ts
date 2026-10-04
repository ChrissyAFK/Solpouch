import { isIP } from 'node:net';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { HttpError } from '../services/orders.js';
import type { FundingRequest } from './types.js';
export interface TransakConfig { apiKey: string; accessToken: string; referrerDomain: string; capabilities: Set<string>; environment: string; }
export function transakConfig(): TransakConfig {
  return {apiKey:process.env.TRANSAK_API_KEY??'',accessToken:process.env.TRANSAK_ACCESS_TOKEN??'',referrerDomain:process.env.TRANSAK_REFERRER_DOMAIN??'',environment:process.env.TRANSAK_ENV??'staging',capabilities:new Set((process.env.TRANSAK_ENABLED_CAPABILITIES??'').split(',').map(s=>s.trim()).filter(Boolean))};
}
export function configured(config:TransakConfig) { return config.environment==='staging' && !!(config.apiKey && config.accessToken && config.referrerDomain); }
export function requireTransak(config:TransakConfig) {
  if(config.environment!=='staging') throw new HttpError(503,'Real-money funding is not enabled. Mainnet readiness and provider approval are still required.');
  if(!configured(config)) throw new HttpError(503,'Bank funding is not configured. Transak staging credentials and a registered domain are required.');
}
export async function createHostedSession(record:FundingRequest,ip:string,config=transakConfig(),transport:typeof fetch=fetch) {
  requireTransak(config);
  if(!config.capabilities.has(`${record.country}:${record.direction}`)) throw new HttpError(503,'This funding route has not been enabled for your region.');
  if(!isIP(ip)) throw new HttpError(503,'Your network address could not be verified. Please try again later.');
  let response:Response;
  try {
    response=await transport('https://api-gateway-stg.transak.com/api/v2/auth/session',{
      method:'POST',headers:{'Content-Type':'application/json','access-token':config.accessToken,'x-api-key':config.apiKey,'x-user-ip':ip},
      body:JSON.stringify({widgetParams:{apiKey:config.apiKey,referrerDomain:config.referrerDomain,countryCode:record.country,fiatCurrency:record.currency,cryptoCurrencyCode:'USDC',network:'solana',walletAddress:record.wallet,disableWalletAddressForm:true,partnerOrderId:record.id,productsAvailed:record.direction,...(record.direction==='BUY'?{fiatAmount:Number(record.amount)}:{cryptoAmount:Number(record.amount)})}}),
      signal:AbortSignal.timeout(15000),redirect:'error',
    });
  } catch { throw new HttpError(503,'The funding provider did not respond. Check this request before starting another payment.'); }
  if(!response.ok) throw new HttpError(503,'The funding provider could not open checkout. No pouch balance was changed.');
  const body=await response.json().catch(()=>null) as {data?:{widgetUrl?:string}}|null;
  let url:URL;
  try { url=new URL(body?.data?.widgetUrl??''); } catch { throw new HttpError(503,'The funding provider returned an invalid checkout link.'); }
  if(url.protocol!=='https:' || url.hostname!=='global-stg.transak.com' || url.username || url.password || url.port || !url.searchParams.get('sessionId')) throw new HttpError(503,'The funding provider returned an invalid checkout link.');
  return url.href;
}
const amount=z.union([z.string(),z.number().finite().positive()]).transform(String).refine(s=>/^\d+(\.\d{1,6})?$/.test(s)&&Number(s)>0,'Invalid provider amount');
export const eventSchema=z.object({eventID:z.string(),webhookData:z.object({id:z.string().min(1).max(200),partnerOrderId:z.string().uuid(),status:z.string(),walletAddress:z.string().optional(),fiatCurrency:z.string(),cryptoCurrency:z.literal('USDC'),network:z.literal('solana'),isBuyOrSell:z.enum(['BUY','SELL']),countryCode:z.enum(['US','CA']),fiatAmount:amount,cryptoAmount:amount.optional(),transactionHash:z.string().max(200).optional()})});
export type TransakEvent=z.infer<typeof eventSchema>;
export async function verifyWebhook(token:string,config=transakConfig()):Promise<TransakEvent> {
  requireTransak(config);
  try {
    const {payload}=await jwtVerify(token,new TextEncoder().encode(config.accessToken),{algorithms:['HS256']});
    return eventSchema.parse(payload);
  } catch { throw new HttpError(400,'Invalid funding notification.'); }
}
/** Authenticated read-only recovery when a webhook was delayed or lost. */
export async function readProviderOrder(record:FundingRequest,config=transakConfig(),transport:typeof fetch=fetch):Promise<TransakEvent|undefined> {
  requireTransak(config);
  const url=new URL(record.providerOrderId?`https://api-stg.transak.com/partners/api/v2/order/${encodeURIComponent(record.providerOrderId)}`:'https://api-stg.transak.com/partners/api/v2/orders');
  if(!record.providerOrderId) {
    url.searchParams.set('filter[partnerOrderId]',record.id);
    url.searchParams.set('filter[productsAvailed]',JSON.stringify([record.direction]));
    url.searchParams.set('limit','2');
    // Completed-only lookup is intentional: absence never proves a request failed.
  }
  let response:Response;
  try {response=await transport(url,{headers:{'access-token':config.accessToken,'x-api-key':config.apiKey},signal:AbortSignal.timeout(15000),redirect:'error'});} catch {throw new HttpError(503,'Funding status could not be checked. Your saved request is unchanged.');}
  if(!response.ok) throw new HttpError(503,'Funding status could not be checked. Your saved request is unchanged.');
  const body=await response.json() as {data?:unknown};
  const candidates=record.providerOrderId?[body.data]:(Array.isArray(body.data)?body.data:[]);
  if(candidates.length===0) return undefined;
  if(candidates.length!==1) throw new HttpError(409,'Multiple provider orders need manual review. No balance was changed.');
  if(!candidates[0] || typeof candidates[0]!=='object' || Array.isArray(candidates[0])) throw new HttpError(503,'Provider status could not be safely matched to this request.');
  const value=candidates[0] as Record<string,unknown>;
  const parsed=eventSchema.safeParse({eventID:'RECONCILED',webhookData:{...value,id:value.id??value._id}});
  if(!parsed.success || parsed.data.webhookData.partnerOrderId!==record.id) throw new HttpError(503,'Provider status could not be safely matched to this request.');
  return parsed.data;
}
