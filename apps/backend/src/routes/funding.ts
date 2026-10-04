import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/session.js';
import { HttpError, type Deps } from '../services/orders.js';
import { clientIp, consumeBudget } from '../security/rateLimit.js';
import { configured, transakConfig, verifyWebhook, readProviderOrder } from '../funding/transak.js';
import { applyFundingEvent, startFunding } from '../funding/service.js';
import { publicFunding } from '../funding/types.js';
import type { FundingRepository } from '../funding/repository.js';
const input=z.object({country:z.enum(['US','CA']),direction:z.enum(['BUY','SELL']),amount:z.string().regex(/^\d{1,6}(\.\d{1,2})?$/).refine(a=>Number(a)>0 && Number(a)<=10000,'Amount must be between 0.01 and 10,000'),idempotencyKey:z.string().uuid()}).strict();
type FundingDeps=Deps & {fundingRepository?:FundingRepository};
function repository(deps:FundingDeps) {if(!deps.fundingRepository) throw new HttpError(503,'Persistent bank funding storage is not configured.');return deps.fundingRepository;}
export function fundingRoutes(deps:FundingDeps) {
  const app=new Hono<AuthEnv>();
  app.get('/config',c=>{
    const config=transakConfig();const ready=configured(config)&&!!deps.fundingRepository;
    return c.json({environment:'staging',productionEnabled:false,configured:ready,countries:(['US','CA'] as const).map(country=>({country,currency:country==='US'?'USD':'CAD',buyEnabled:ready&&config.capabilities.has(`${country}:BUY`),sellEnabled:ready&&config.capabilities.has(`${country}:SELL`)})),notice:'Sandbox only. Provider checkout shows available methods, eligibility, current quotes and fees before confirmation. No real money or pouch balance changes.'});
  });
  app.get('/',async c=>c.json((await repository(deps).list(c.get('user').email)).map(publicFunding)));
  app.post('/',async c=>{
    const body=input.parse(await c.req.json());
    await consumeBudget(deps.store,`funding:${c.get('user').email}`,60000,5);
    const result=await startFunding(repository(deps),deps.store,c.get('user').email,body,clientIp(c),transakConfig());
    return c.json({...result,request:publicFunding(result.request)},201);
  });
  app.post('/:id/reconcile',async c=>{
    const record=await repository(deps).get(c.req.param('id'));
    if(!record || record.owner!==c.get('user').email) throw new HttpError(404,'Funding request not found.');
    await consumeBudget(deps.store,`funding-status:${record.owner}`,60000,10);
    const event=await readProviderOrder(record);
    return c.json(publicFunding(event?await applyFundingEvent(repository(deps),event):record));
  });
  return app;
}
/** Provider webhook is deliberately separate from dashboard authentication. JWT verifies its sender. */
export function fundingWebhookRoutes(deps:FundingDeps) {
  const app=new Hono();
  app.post('/transak',async c=>{
    const {data}=z.object({data:z.string().min(10).max(60000)}).parse(await c.req.json());
    await applyFundingEvent(repository(deps),await verifyWebhook(data));
    return c.json({received:true});
  });
  return app;
}
