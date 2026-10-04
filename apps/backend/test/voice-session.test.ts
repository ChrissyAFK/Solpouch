import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store/memory.js';
import { MockVaultClient } from '../src/vault/mock.js';
import { COOKIE, hashToken, issueSession } from '../src/security/auth.js';

const origin = 'http://localhost:3000';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function setup() {
  vi.stubEnv('ELEVENLABS_API_KEY', 'private-provider-key');
  vi.stubEnv('ELEVENLABS_AGENT_ID', 'test-agent');
  vi.stubEnv('VOICE_WEBHOOK_SECRET', 'private-tool-secret');
  vi.stubEnv('ELEVENLABS_SECURE_TOOLS_CONFIGURED', 'true');
  const store = new MemoryStore();
  const app = createApp({ store, vault: new MockVaultClient(store, () => undefined) });
  const web = await issueSession(store, 'test-wallet');
  const headers = { origin, cookie: `${COOKIE}=${web.token}` };
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=fixture' })));
  vi.stubGlobal('fetch', fetch);
  return { store, app, web, headers, fetch };
}
describe('authenticated ElevenLabs session bridge', () => {
  it('requires a browser session and operator configuration before contacting the provider', async () => {
    const { app, headers, fetch } = await setup();
    expect((await app.request('/auth/voice-session', { method: 'POST', headers: { origin } })).status).toBe(401);
    expect((await app.request('/auth/voice-session', { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('/auth/voice-session', { method: 'POST', headers: { cookie: headers.cookie } })).status).toBe(403);
    vi.stubEnv('ELEVENLABS_SECURE_TOOLS_CONFIGURED', 'false');
    expect(await (await app.request('/auth/voice-status', { headers })).json()).toEqual({ enabled: false });
    expect((await app.request('/auth/voice-session', { method: 'POST', headers })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses server credentials and issues an expiring scoped child session without disclosing shared secrets', async () => {
    const { app, store, headers, fetch, web } = await setup();
    const response = await app.request('/auth/voice-session', { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.signedUrl).toMatch(/^wss:\/\/api\.elevenlabs\.io/);
    expect(JSON.stringify(body)).not.toContain('private-');
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(299000);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(300000);
    expect(fetch.mock.calls[0][0].searchParams.get('agent_id')).toBe('test-agent');
    expect(fetch.mock.calls[0][1].headers['xi-api-key']).toBe('private-provider-key');
    const saved = await store.getSession(hashToken(body.token));
    expect(saved).toMatchObject({ scope: 'voice', parentTokenHash: hashToken(web.token), wallet: 'test-wallet' });
    expect((await app.request('/pouches', { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(401);
    const toolHeaders = { authorization: `Bearer ${body.token}`, 'X-Solpouch-Secret': 'private-tool-secret' };
    expect((await app.request('/voice/tools/get_pouches', { method: 'POST', headers: toolHeaders, body: '{}' })).status).toBe(200);
    await store.deleteSession(hashToken(body.token));
    await store.saveSession({ ...saved!, expiresAt: new Date(Date.now()-1).toISOString() });
    expect((await app.request('/voice/tools/get_pouches', { method: 'POST', headers: toolHeaders, body: '{}' })).status).toBe(401);
  });
  it('rejects provider errors and untrusted URLs without leaking provider details', async () => {
    const { app, headers, fetch } = await setup();
    for (const response of [new Response('private-provider-key', { status: 401 }), new Response(JSON.stringify({ signed_url: 'wss://evil.example' })), new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/wrong-path' })), new Response('{}')]) {
      fetch.mockResolvedValueOnce(response);
      const result = await app.request('/auth/voice-session', { method: 'POST', headers });
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain('private-provider-key');
    }
    fetch.mockRejectedValueOnce(new Error('timeout'));
    expect((await app.request('/auth/voice-session', { method: 'POST', headers })).status).toBe(503);
  });
  it('revokes voice access when its parent logs out, including logout during provider setup', async () => {
    const { app, headers, store, web, fetch } = await setup();
    const child = await (await app.request('/auth/voice-session', { method: 'POST', headers })).json();
    await store.deleteSession(hashToken(web.token));
    expect((await app.request('/voice/tools/get_pouches', { method: 'POST', headers: { authorization: `Bearer ${child.token}`, 'X-Solpouch-Secret': 'private-tool-secret' }, body: '{}' })).status).toBe(401);
    const second = await issueSession(store, 'test-wallet');
    fetch.mockImplementationOnce(async () => {
      await store.deleteSession(hashToken(second.token));
      return new Response(JSON.stringify({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=fixture' }));
    });
    expect((await app.request('/auth/voice-session', { method: 'POST', headers: { origin, cookie: `${COOKIE}=${second.token}` } })).status).toBe(401);
  });
});
