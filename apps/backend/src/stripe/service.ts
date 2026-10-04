import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { HttpError, type Deps } from '../services/orders.js';
import { stripeProvider, testStripeKey, type StripeSession } from './provider.js';
import type { StripeFundingRequest } from './repository.js';
export function stripeConfig(deps: Deps) { const rate = process.env.FUNDING_USD_PER_CAD || '0.73'; const valid = /^0\.\d{1,6}$|^[1-9]\d?(\.\d{1,6})?$/.test(rate) && Number(rate)>0 && Number(rate)<=2; return { provider: 'stripe' as const, environment: 'test' as const, productionEnabled: false, configured: valid && !!deps.stripeRepository && !!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'), usdPerCad: valid ? rate : '0.73', minAmountCad: 5, maxAmountCad: 200, mintEnabled: process.env.VAULT_MODE === 'chain' && process.env.STRIPE_DEMO_MINT === '1' && !!deps.stripeMint }; }
export function publicStripe(r: StripeFundingRequest) { const { owner, idempotencyKey, mintOperation, checkoutUrl, ...safe } = r; return safe; }
export function stripeRepo(deps: Deps) { if (!deps.stripeRepository)
    throw new HttpError(503, 'Persistent card funding storage is not configured.'); return deps.stripeRepository; }
const provider = (deps: Deps) => deps.stripeProvider ?? stripeProvider();
export async function startStripe(deps: Deps, owner: string, amountCad: string, idempotencyKey: string) {
    if (process.env.FUNDING_PROVIDER !== 'stripe')
        throw new HttpError(503, 'Card funding is not enabled.');
    testStripeKey();
    const config = stripeConfig(deps);
    if (!config.configured)
        throw new HttpError(503, 'Card funding is not configured.');
    const wallet = (await deps.store.getUser(owner))?.wallet;
    if (!wallet)
        throw new HttpError(409, 'Link a wallet before adding money.');
    try {
        if (!PublicKey.isOnCurve(new PublicKey(wallet)))
            throw Error();
    }
    catch {
        throw new HttpError(409, 'Link a valid wallet before adding money.');
    }
    if(!/^\d{1,3}(\.\d{1,2})?$/.test(amountCad)||Number(amountCad)<5||Number(amountCad)>200) throw new HttpError(400,'Amount must be between 5 and 200 CAD with at most two decimal places.');
    const amountCents = Math.round(Number(amountCad) * 100);
    const rateMicros = BigInt(config.usdPerCad.split('.')[0]) * 1000000n + BigInt((config.usdPerCad.split('.')[1] || '').padEnd(6, '0'));
    const usdcMicros = Number(BigInt(amountCents) * rateMicros / 100n);
    if(!Number.isSafeInteger(usdcMicros)||usdcMicros<=0) throw new HttpError(503,'The configured funding quote is invalid.');
    const repo = stripeRepo(deps);
    const record = await repo.create({ id: randomUUID(), provider: 'stripe', owner, idempotencyKey, wallet, amountCad: (amountCents / 100).toFixed(2), amountCents, usdPerCad: config.usdPerCad, usdcMicros, usdcAmount: (usdcMicros / 1000000).toFixed(6), status: 'created', createdAt: new Date().toISOString() });
    if (record.amountCents !== amountCents || record.wallet !== wallet)
        throw new HttpError(409, 'This payment key was already used for a different request.');
    return repo.withLock(record.id, async () => {
        let fresh = (await repo.get(record.id))!;
        if (fresh.sessionId) {
            if (fresh.status === 'created' || fresh.status === 'checkout_ready') {
                const existing = await provider(deps).retrieve(fresh.sessionId);
                validateSession(fresh, existing);
                if (existing.payment_status === 'paid') fresh = await repo.update(fresh.id, r => ({...r, status:'paid'}));
                else if (existing.status === 'expired') fresh = await repo.update(fresh.id, r => ({...r, status:'expired', checkoutUrl:undefined}));
            }
            return { request: publicStripe(fresh), url: fresh.status === 'checkout_ready' ? fresh.checkoutUrl : undefined };
        }
        // Stripe can prune idempotency records after 24h. An uncertain old creation must never create another chargeable session.
        if (Date.now() - Date.parse(fresh.createdAt) > 23 * 60 * 60 * 1000)
            throw new HttpError(409, 'This checkout could not be recovered. Contact support before trying another payment.');
        const session = await provider(deps).create(fresh);
        validateSession(fresh, session);
        if (!session.url || !/^https:\/\/checkout\.stripe\.com\//.test(session.url))
            throw new HttpError(503, 'Stripe did not return a valid checkout.');
        fresh = await repo.update(fresh.id, r => ({ ...r, sessionId: session.id, checkoutUrl: session.url!, status: 'checkout_ready' }));
        return { request: publicStripe(fresh), url: fresh.checkoutUrl };
    });
}
function validateSession(r: StripeFundingRequest, s: StripeSession) { if (s.livemode !== false || !s.id.startsWith('cs_test_') || s.amount_total !== r.amountCents || s.currency !== 'cad' || s.client_reference_id !== r.id || s.metadata?.fundingRequestId !== r.id || (r.sessionId && r.sessionId !== s.id))
    throw new HttpError(409, 'Stripe payment does not match this funding request.'); }
export async function reconcileStripe(deps: Deps, id: string, owner?: string, sessionId?: string) {
    const repo = stripeRepo(deps);
    let record = await repo.get(id);
    if (!record && id.startsWith('cs_test_'))
        record = await repo.bySession(id);
    if (!record || (owner !== undefined && record.owner !== owner))
        throw new HttpError(404, 'Funding request not found.');
    const requestId = record.id;
    return repo.withLock(requestId, async () => {
        let fresh = (await repo.get(requestId))!;
        if (fresh.status === 'confirmed')
            return fresh;
        const sid = fresh.sessionId || sessionId;
        if (!sid)
            return fresh;
        const session = await provider(deps).retrieve(sid);
        validateSession(fresh, session);
        if (session.payment_status !== 'paid') {
            if (session.status === 'expired' && fresh.status !== 'paid')
                return repo.update(fresh.id, r => ({...r, status:'expired', checkoutUrl:undefined}));
            return fresh;
        }
        fresh = await repo.update(fresh.id, r => ({ ...r, status: r.status === 'confirmed' ? 'confirmed' : 'paid', sessionId: session.id }));
        if (fresh.status === 'confirmed')
            return fresh;
        if (process.env.VAULT_MODE === 'chain' && process.env.STRIPE_DEMO_MINT === '1' && deps.stripeMint) {
            const result = await deps.stripeMint(fresh, repo);
            fresh = await repo.update(fresh.id, r => ({ ...r, status: 'confirmed', txSignature: result.txSignature }));
        }
        return fresh;
    });
}
export async function stripeWebhook(deps: Deps, raw: string, signature: string) { const event = provider(deps).verify(raw, signature); if (event.livemode)
    throw new HttpError(400, 'Live Stripe events are not accepted.'); if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type))
    return; const session = event.data.object; if (session.payment_status !== 'paid')
    return; if (!session.metadata?.fundingRequestId)
    throw new HttpError(400, 'Funding request is missing.'); await reconcileStripe(deps, session.metadata.fundingRequestId, undefined, session.id); }
