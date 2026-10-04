import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { MockVaultClient } from '../src/vault/mock.js';
import { MemoryStripeRepository } from '../src/stripe/repository.js';
import { startStripe, reconcileStripe, stripeWebhook } from '../src/stripe/service.js';
import type { StripeSession, StripeProvider } from '../src/stripe/provider.js';
import { authHeaders, linkTestWallet, TEST_USER } from './helpers.js';
import { randomUUID } from 'node:crypto';
afterEach(() => vi.unstubAllEnvs());
async function fixture() { vi.stubEnv('FUNDING_PROVIDER', 'stripe'); vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture'); vi.stubEnv('FUNDING_USD_PER_CAD', '0.73'); vi.stubEnv('VAULT_MODE', 'mock'); const store = new MemoryStore([]); await linkTestWallet(store); const stripeRepository = new MemoryStripeRepository(); let session: StripeSession; const stripeProvider: StripeProvider = { create: vi.fn(async (r) => session = { id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/test', livemode: false, payment_status: 'unpaid', amount_total: r.amountCents, currency: 'cad', client_reference_id: r.id, metadata: { fundingRequestId: r.id } }), retrieve: vi.fn(async () => session), verify: vi.fn(() => ({ type: 'checkout.session.completed', livemode: false, data: { object: session } })) }; const deps = { store, vault: new MockVaultClient(store, () => undefined), stripeRepository, stripeProvider, stripeMint: vi.fn(async () => ({ txSignature: 'sig' })) }; return { deps, pay: () => session.payment_status = 'paid', session: () => session }; }
describe('Stripe test funding', () => {
    it('stores immutable exact quote and reuses checkout', async () => { const { deps } = await fixture(); const key = randomUUID(); const a = await startStripe(deps, TEST_USER, '25', key); vi.stubEnv('FUNDING_USD_PER_CAD', '0.99'); const b = await startStripe(deps, TEST_USER, '25', key); expect(b.request.usdcAmount).toBe('18.250000'); expect(a.request.id).toBe(b.request.id); expect(deps.stripeProvider.create).toHaveBeenCalledTimes(1); await expect(startStripe(deps, TEST_USER, '26', key)).rejects.toThrow('different request'); });
    it('rejects live keys before checkout', async () => { const { deps } = await fixture(); vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_no'); await expect(startStripe(deps, TEST_USER, '25', randomUUID())).rejects.toThrow('Live payments are disabled'); expect(deps.stripeProvider.create).not.toHaveBeenCalled(); });
    it('does not create another session after idempotency retention expires', async () => { const { deps } = await fixture(); const key = randomUUID(); vi.mocked(deps.stripeProvider.create).mockRejectedValueOnce(Error('unknown delivery')); await expect(startStripe(deps, TEST_USER, '25', key)).rejects.toThrow(); const record = (await deps.stripeRepository.list(TEST_USER))[0]; await deps.stripeRepository.update(record.id, r => ({ ...r, createdAt: new Date(Date.now() - 24 * 3600000).toISOString() })); await expect(startStripe(deps, TEST_USER, '25', key)).rejects.toThrow('could not be recovered'); expect(deps.stripeProvider.create).toHaveBeenCalledTimes(1); });
    it('does not mint unpaid or disabled payments, and rejects another owner', async () => { const { deps, pay } = await fixture(); const { request } = await startStripe(deps, TEST_USER, '25', randomUUID()); await reconcileStripe(deps, request.id, TEST_USER); expect(deps.stripeMint).not.toHaveBeenCalled(); await expect(reconcileStripe(deps, request.id, 'other@example.com')).rejects.toThrow('not found'); pay(); expect((await reconcileStripe(deps, request.id, TEST_USER)).status).toBe('paid'); expect(deps.stripeMint).not.toHaveBeenCalled(); });
    it('mints once across repeated webhook and poll and resolves owner session', async () => { const { deps, pay } = await fixture(); const { request } = await startStripe(deps, TEST_USER, '25', randomUUID()); pay(); vi.stubEnv('VAULT_MODE', 'chain'); vi.stubEnv('STRIPE_DEMO_MINT', '1'); await stripeWebhook(deps, 'raw', 'signature'); expect((await reconcileStripe(deps, 'cs_test_fixture', TEST_USER)).status).toBe('confirmed'); await stripeWebhook(deps, 'raw', 'signature'); expect(deps.stripeMint).toHaveBeenCalledTimes(1); expect((await deps.stripeRepository.get(request.id))?.txSignature).toBe('sig'); });
    it.each(['amount', 'currency', 'metadata', 'live'])('rejects mismatched %s before mint', async (kind) => { const { deps, pay, session } = await fixture(); const { request } = await startStripe(deps, TEST_USER, '25', randomUUID()); pay(); if (kind === 'amount')
        session().amount_total = 1; if (kind === 'currency')
        session().currency = 'usd'; if (kind === 'metadata')
        session().metadata = { fundingRequestId: 'wrong' }; if (kind === 'live')
        session().livemode = true; await expect(reconcileStripe(deps, request.id, TEST_USER)).rejects.toThrow('does not match'); expect(deps.stripeMint).not.toHaveBeenCalled(); });
    it('authenticates routes and validates amount', async () => { const { deps } = await fixture(); const app = createApp(deps); expect((await app.request('/funding/stripe')).status).toBe(401); const headers = { ...await authHeaders(deps.store), 'Content-Type': 'application/json' }; for (const amountCad of [4, 201, 25.001, 'NaN']) {
        const res = await app.request('/funding/stripe/checkout', { method: 'POST', headers, body: JSON.stringify({ amountCad, idempotencyKey: randomUUID() }) });
        expect(res.status).toBe(400);
    } expect(deps.stripeProvider.create).not.toHaveBeenCalled(); });
    it('requires webhook signature and does not expose private journal', async () => { const { deps } = await fixture(); const app = createApp(deps); expect((await app.request('/funding-webhooks/stripe', { method: 'POST', body: '{}' })).status).toBe(400); const { request } = await startStripe(deps, TEST_USER, '25', randomUUID()); expect(request).not.toHaveProperty('owner'); expect(request).not.toHaveProperty('mintOperation'); });
});
describe('Stripe webhook boundary', () => {
    it('keeps raw body, bypasses write budget only for exact webhook and retains body limit', async () => { const { deps } = await fixture(); const app = createApp(deps); vi.mocked(deps.stripeProvider.verify).mockReturnValue({ type: 'irrelevant', livemode: false, data: { object: {} as StripeSession } }); for (let i = 0; i < 35; i++) {
        const res = await app.request('/funding-webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'test', Origin: 'https://untrusted.example' }, body: '{"raw": true}' });
        expect(res.status).toBe(200);
    } expect(deps.stripeProvider.verify).toHaveBeenLastCalledWith('{"raw": true}', 'test'); expect((await app.request('/funding-webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'test' }, body: 'x'.repeat(65537) })).status).toBe(413); });
    it('preserves paid state if mint fails and retries same request', async () => { const { deps, pay } = await fixture(); const { request } = await startStripe(deps, TEST_USER, '25', randomUUID()); pay(); vi.stubEnv('VAULT_MODE', 'chain'); vi.stubEnv('STRIPE_DEMO_MINT', '1'); deps.stripeMint.mockRejectedValueOnce(Error('RPC down')); await expect(reconcileStripe(deps, request.id, TEST_USER)).rejects.toThrow('RPC down'); expect((await deps.stripeRepository.get(request.id))?.status).toBe('paid'); expect((await reconcileStripe(deps, request.id, TEST_USER)).status).toBe('confirmed'); });
});

it('expires unpaid sessions without reusing their checkout URL', async()=>{
 const {deps,session}=await fixture(); const key=randomUUID();
 const {request}=await startStripe(deps,TEST_USER,'25',key);
 session().status='expired';
 expect((await reconcileStripe(deps,request.id,TEST_USER)).status).toBe('expired');
 expect((await startStripe(deps,TEST_USER,'25',key)).url).toBeUndefined();
 expect(deps.stripeProvider.create).toHaveBeenCalledTimes(1);
 expect(deps.stripeMint).not.toHaveBeenCalled();
});
it('does not regress recorded paid state on an expired unpaid response',async()=>{
 const {deps,pay,session}=await fixture();
 const {request}=await startStripe(deps,TEST_USER,'25',randomUUID());pay();
 expect((await reconcileStripe(deps,request.id,TEST_USER)).status).toBe('paid');
 session().status='expired';session().payment_status='unpaid';
 expect((await reconcileStripe(deps,request.id,TEST_USER)).status).toBe('paid');
});
