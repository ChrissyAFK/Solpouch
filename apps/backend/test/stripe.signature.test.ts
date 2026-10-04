import Stripe from 'stripe';
import { afterEach,expect,it,vi } from 'vitest';
import { stripeProvider } from '../src/stripe/provider.js';
afterEach(()=>vi.unstubAllEnvs());
it('verifies the exact raw webhook body with the actual Stripe SDK and rejects alterations',()=>{
 vi.stubEnv('STRIPE_SECRET_KEY','sk_test_fixture');vi.stubEnv('STRIPE_WEBHOOK_SECRET','whsec_fixture');
 const stripe=new Stripe('sk_test_fixture');const body=JSON.stringify({id:'evt_test',object:'event',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test_fixture'}}});
 const signature=stripe.webhooks.generateTestHeaderString({payload:body,secret:'whsec_fixture'});
 const provider=stripeProvider();expect(provider.verify(body,signature).type).toBe('checkout.session.completed');
 expect(()=>provider.verify(body.replace('cs_test_fixture','cs_test_other'),signature)).toThrow('Invalid Stripe signature');
 expect(()=>provider.verify(body,'invalid')).toThrow('Invalid Stripe signature');
 const expired=stripe.webhooks.generateTestHeaderString({payload:body,secret:'whsec_fixture',timestamp:Math.floor(Date.now()/1000)-600});
 expect(()=>provider.verify(body,expired)).toThrow('Invalid Stripe signature');
});
