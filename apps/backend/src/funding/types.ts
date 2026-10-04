export type FundingStatus = 'created' | 'session_ready' | 'session_uncertain' | 'processing' | 'provider_completed' | 'sandbox_completed' | 'confirmed' | 'failed' | 'cancelled' | 'refunded';
export interface FundingRequest {
  id: string; owner: string; idempotencyKey: string; country: 'US' | 'CA'; currency: 'USD' | 'CAD';
  direction: 'BUY' | 'SELL'; amount: string; wallet: string; environment: 'staging'; status: FundingStatus;
  createdAt: string; updatedAt: string; providerOrderId?: string; txSignature?: string; cryptoAmount?: string; message?: string;
}
export function publicFunding(record: FundingRequest) {
  const {owner: _owner, idempotencyKey: _key, ...result} = record;
  return result;
}
