import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { MockVaultClient } from '../src/vault/mock.js';
import { verifyVoiceToken } from '../src/auth/session.js';
import { authHeaders, ownedSeed, TEST_USER } from './helpers.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function setup() {
  vi.stubEnv('ELEVENLABS_API_KEY', 'private-provider-key');
  vi.stubEnv('ELEVENLABS_AGENT_ID', 'test-agent');
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'private-tool-secret');
  vi.stubEnv('ELEVENLABS_SECURE_TOOLS_CONFIGURED', 'true');
  const store = new MemoryStore(ownedSeed());
  const app = createApp({ store, vault: new MockVaultClient(store, () => undefined) });
  const headers = await authHeaders(store);
  const fetch = vi.fn().mockImplementation(async (url: URL) => String(url).includes('/conversation/token')
    ? new Response(JSON.stringify({ token: 'rtc-fixture-token' }))
    : new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=fixture' })));
  vi.stubGlobal('fetch', fetch);
  return { store, app, headers, fetch };
}
describe('authenticated ElevenLabs session bridge', () => {
  it('requires a Google session and operator configuration before contacting the provider', async () => {
    const { store, app, headers, fetch } = await setup();
    expect((await app.request('/auth/voice-session', { method: 'POST' })).status).toBe(401);
    vi.stubEnv('ELEVENLABS_SECURE_TOOLS_CONFIGURED', 'false');
    expect(await (await app.request('/auth/voice-status', { headers })).json()).toEqual({ enabled: false });
    expect((await app.request('/auth/voice-session', { method: 'POST', headers })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses server credentials and issues an expiring voice-scoped token without disclosing shared secrets', async () => {
    const { store, app, headers, fetch } = await setup();
    const response = await app.request('/auth/voice-session', { method: 'POST', headers });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signedUrl).toMatch(/^wss:\/\/api\.elevenlabs\.io/);
    expect(JSON.stringify(body)).not.toContain('private-');
    // expiresAt is an ISO string the web parses with new Date().
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(fetch.mock.calls[0][0].searchParams.get('agent_id')).toBe('test-agent');
    expect(fetch.mock.calls[0][1].headers['xi-api-key']).toBe('private-provider-key');
    expect(await verifyVoiceToken(body.token, store)).toBe(TEST_USER);
    // A voice token is not a session token.
    expect((await app.request('/pouches', { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(401);
    const toolHeaders = { authorization: `Bearer ${body.token}`, 'X-Solpouch-Secret': 'private-tool-secret' };
    expect((await app.request('/voice/tools/get_pouches', { method: 'POST', headers: toolHeaders, body: '{}' })).status).toBe(200);
    expect((await app.request('/voice/tools/get_pouches', { method: 'POST', headers: { ...toolHeaders, 'X-Solpouch-Secret': 'wrong' }, body: '{}' })).status).toBe(401);
  });
  it('returns a WebRTC conversationToken and degrades to websocket-only when the token call fails', async () => {
    const { app, headers, fetch } = await setup();
    const ok = await (await app.request('/auth/voice-session', { method: 'POST', headers })).json();
    expect(ok.conversationToken).toBe('rtc-fixture-token');
    expect(ok.signedUrl).toMatch(/^wss:/);
    const tokenCall = fetch.mock.calls.find(([u]) => String(u).includes('/conversation/token'));
    expect(tokenCall![0].searchParams.get('agent_id')).toBe('test-agent');
    expect(tokenCall![1].headers['xi-api-key']).toBe('private-provider-key');
    const signed = (url: URL) => !String(url).includes('/conversation/token');
    for (const failure of [() => new Response('nope', { status: 500 }), () => new Response('{}'), () => new Response(JSON.stringify({ token: 'x'.repeat(5000) })), () => { throw new Error('timeout'); }]) {
      fetch.mockImplementation(async (url: URL) => signed(url) ? new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=fixture' })) : failure());
      const res = await app.request('/auth/voice-session', { method: 'POST', headers });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.signedUrl).toMatch(/^wss:/);
      expect(body.conversationToken).toBeUndefined();
    }
  });
  it('rejects provider errors and untrusted URLs without leaking provider details', async () => {
    const { store, app, headers, fetch } = await setup();
    for (const response of [new Response('private-provider-key', { status: 401 }), new Response(JSON.stringify({ signed_url: 'wss://evil.example' })), new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/wrong-path' })), new Response('{}')]) {
      fetch.mockResolvedValueOnce(response);
      const result = await app.request('/auth/voice-session', { method: 'POST', headers });
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain('private-provider-key');
    }
    fetch.mockRejectedValueOnce(new Error('timeout'));
    expect((await app.request('/auth/voice-session', { method: 'POST', headers })).status).toBe(503);
  });
});
