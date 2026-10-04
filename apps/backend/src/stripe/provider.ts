import { createRequire } from 'node:module';
import type StripeClient from 'stripe';
import type { StripeFundingRequest } from './repository.js';
import { HttpError } from '../services/orders.js';
export interface StripeSession {
    id: string;
    url?: string | null;
    livemode: boolean;
    payment_status: string;
    status?: string | null;
    amount_total: number | null;
    currency: string | null;
    client_reference_id: string | null;
    metadata: Record<string, string> | null;
}
export interface StripeProvider {
    create(r: StripeFundingRequest): Promise<StripeSession>;
    retrieve(id: string): Promise<StripeSession>;
    verify(raw: string, signature: string): {
        type: string;
        livemode: boolean;
        data: {
            object: StripeSession;
        };
    };
}
export function testStripeKey() { const key = process.env.STRIPE_SECRET_KEY ?? ''; if (!key.startsWith('sk_test_'))
    throw new HttpError(503, 'Stripe test checkout is not configured. Live payments are disabled.'); return key; }
export function stripeProvider(): StripeProvider {
    // Loaded on first use so a missing install or unset Stripe env can never stop the API booting.
    const mod = createRequire(import.meta.url)('stripe') as { default?: typeof StripeClient } & typeof StripeClient;
    const Stripe = mod.default ?? mod;
    const stripe = new Stripe(testStripeKey(), { maxNetworkRetries: 1, timeout: 15000 });
    return {
        async create(r) { const origin = process.env.FUNDING_RETURN_ORIGIN || 'https://solpouch.tech'; const url = new URL(origin); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
            throw new HttpError(503, 'Funding return URL is invalid.'); return stripe.checkout.sessions.create({ mode: 'payment', client_reference_id: r.id, metadata: { fundingRequestId: r.id }, line_items: [{ quantity: 1, price_data: { currency: 'cad', unit_amount: r.amountCents, product_data: { name: 'Add money to Solpouch', description: `Test card payment: ${r.usdcAmount} devnet test-USDC to ${r.wallet}` } } }], success_url: `${url.origin}/funding?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${url.origin}/funding` }, { idempotencyKey: `solpouch-funding-${r.id}` }); },
        retrieve(id) { return stripe.checkout.sessions.retrieve(id); },
        verify(raw, signature) { const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret)
            throw new HttpError(503, 'Stripe webhook is not configured.'); try {
            return stripe.webhooks.constructEvent(raw, signature, secret) as unknown as ReturnType<StripeProvider['verify']>;
        }
        catch {
            throw new HttpError(400, 'Invalid Stripe signature.');
        } }
    };
}
