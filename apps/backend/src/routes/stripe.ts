import { MintPending } from '../stripe/mint.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/session.js';
import { HttpError, type Deps } from '../services/orders.js';
import { consumeBudget } from '../security/rateLimit.js';
import { StripeBusy } from '../stripe/repository.js';
import { publicStripe, reconcileStripe, startStripe, stripeConfig, stripeRepo, stripeWebhook } from '../stripe/service.js';
const input = z.object({ amountCad: z.union([z.string(), z.number()]).transform(String).refine(v => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) >= 5 && Number(v) <= 200, 'Amount must be between 5 and 200 CAD with at most two decimal places.'), idempotencyKey: z.string().uuid() }).strict();
export function stripeRoutes(deps: Deps) {
    const app = new Hono<AuthEnv>();
    app.get('/config', (c, next) => process.env.FUNDING_PROVIDER === 'stripe' ? c.json(stripeConfig(deps)) : next());
    app.get('/stripe', async (c) => c.json((await stripeRepo(deps).list(c.get('user').email)).map(publicStripe)));
    app.post('/stripe/checkout', async (c) => { const body = input.parse(await c.req.json()); await consumeBudget(deps.store, `stripe-checkout:${c.get('user').email}`, 60000, 5); try {
        return c.json(await startStripe(deps, c.get('user').email, body.amountCad, body.idempotencyKey), 201);
    }
    catch (e) {
        if (e instanceof StripeBusy)
            throw new HttpError(409, 'This payment is processing. Try again shortly.');
        throw e;
    } });
    app.get('/stripe/:id', async (c) => { await consumeBudget(deps.store, `stripe-poll:${c.get('user').email}`, 60000, 40); try {
        return c.json(publicStripe(await reconcileStripe(deps, c.req.param('id'), c.get('user').email)));
    }
    catch (e) {
        if (e instanceof StripeBusy || e instanceof MintPending) {
            const record = await stripeRepo(deps).get(c.req.param('id')) ?? await stripeRepo(deps).bySession(c.req.param('id'));
            if (record?.owner === c.get('user').email)
                return c.json(publicStripe(record));
            throw new HttpError(404, 'Funding request not found.');
        }
        throw e;
    } });
    return app;
}
export function stripeWebhookRoutes(deps: Deps) { const app = new Hono(); app.post('/stripe', async (c) => { const signature = c.req.header('stripe-signature'); if (!signature)
    throw new HttpError(400, 'Stripe signature is required.'); try {
    await stripeWebhook(deps, await c.req.text(), signature);
}
catch (e) {
    if (e instanceof StripeBusy)
        throw new HttpError(503, 'Payment processing; retry delivery.');
    throw e;
} return c.json({ received: true }); }); return app; }
