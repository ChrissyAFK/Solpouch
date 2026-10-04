import { afterEach, describe, expect, it } from 'vitest';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../src/app.js';
import { MemoryStore, seedPouches } from '../src/store/memory.js';
import { getMerchant } from '../src/merchants/index.js';
import { MockVaultClient } from '../src/vault/mock.js';
import { hashToken, issueSession } from '../src/security/auth.js';

const origin = 'http://localhost:3000';
const oldSecret = process.env.VOICE_WEBHOOK_SECRET;
afterEach(() => { if (oldSecret === undefined) delete process.env.VOICE_WEBHOOK_SECRET; else process.env.VOICE_WEBHOOK_SECRET = oldSecret; });
function setup() {
  const owner = Keypair.generate(), stranger = Keypair.generate();
  const pouches = seedPouches().map(p => ({ ...p, ownerWallet: owner.publicKey.toBase58() }));
  const store = new MemoryStore(pouches);
  const app = createApp({ store, vault: new MockVaultClient(store, id => getMerchant(id)?.payTo) });
  return { owner, stranger, store, app, pouches };
}
async function login(app: ReturnType<typeof createApp>, key: Keypair) {
  const challengeResponse = await app.request('/auth/challenge', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ wallet: key.publicKey.toBase58() }) });
  expect(challengeResponse.status).toBe(200);
  const challenge = await challengeResponse.json();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(key.secretKey.slice(0,32))]), format: 'der', type: 'pkcs8' });
  const payload = { id: challenge.id, signature: sign(null, Buffer.from(challenge.message), privateKey).toString('base64') };
  const response = await app.request('/auth/verify', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { cookie, payload, response };
}
describe('wallet authentication and ownership', () => {
  it('verifies a real signature, uses private cookie, rejects replay, and revokes logout', async () => {
    const { app, owner } = setup(); const { cookie, payload, response } = await login(app, owner);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect((await app.request('/auth/session', { headers: { cookie } })).status).toBe(200);
    expect((await app.request('/auth/verify', { method: 'POST', headers: { origin }, body: JSON.stringify(payload) })).status).toBe(401);
    expect((await app.request('/auth/logout', { method: 'POST', headers: { origin, cookie } })).status).toBe(200);
    expect((await app.request('/pouches', { headers: { cookie } })).status).toBe(401);
  });
  it('rejects foreign signatures and expired challenges', async () => {
    const { app, owner, store } = setup();
    const id = 'a'.repeat(48);
    await store.saveChallenge({ id, wallet: owner.publicKey.toBase58(), message: `\nURI: ${origin}\n`, expiresAt: new Date(Date.now()-1).toISOString() });
    const r = await app.request('/auth/verify', { method: 'POST', headers: { origin }, body: JSON.stringify({ id, signature: randomBytes(64).toString('base64') }) });
    expect(r.status).toBe(401);
    const c = await (await app.request('/auth/challenge', { method: 'POST', headers: { origin }, body: JSON.stringify({ wallet: owner.publicKey.toBase58() }) })).json();
    expect((await app.request('/auth/verify', { method: 'POST', headers: { origin }, body: JSON.stringify({ id: c.id, signature: randomBytes(64).toString('base64') }) })).status).toBe(401);
  });
  it('blocks anonymous reads and cross-site cookie mutations', async () => {
    const { app, owner, pouches } = setup();
    for (const path of ['/pouches', '/orders', '/stats', '/chat']) expect((await app.request(path)).status).toBe(401);
    const { cookie } = await login(app, owner);
    for (const headers of [{ cookie, origin: '' }, { cookie, origin: 'https://evil.example' }]) {
      expect((await app.request(`/pouches/${pouches[0].id}/freeze`, { method: 'POST', headers })).status).toBe(403);
    }
  });
  it('hides legacy and foreign pouches and every dependent object', async () => {
    const { app, owner, stranger, store, pouches } = setup();
    const legacy = { ...pouches[0], id: 'legacy', ownerWallet: undefined }; await store.savePouch(legacy);
    const p = pouches[0];
    await store.saveOrder({ id:'secret-order', pouchId:p.id, merchantId:'freshmart', request:'eggs', lines:[], total:1, status:'draft', createdAt:new Date().toISOString() });
    await store.saveTopUp({ id:'secret-topup', pouchId:p.id, amount:1, reason:'Testing', status:'cooling_down', readyAt:new Date().toISOString(), createdAt:new Date().toISOString() });
    const { cookie } = await login(app, stranger);
    expect(await (await app.request('/pouches', { headers:{cookie} })).json()).toEqual([]);
    expect(await (await app.request('/orders', { headers:{cookie} })).json()).toEqual([]);
    for (const path of [`/pouches/${p.id}`, '/pouches/legacy', '/orders/secret-order', '/topups/secret-topup']) expect((await app.request(path, { headers:{cookie} })).status).toBe(404);
    for (const path of ['/orders/secret-order/confirm', '/topups/secret-topup/complete', `/pouches/${p.id}/freeze`]) expect((await app.request(path, { method:'POST', headers:{cookie,origin} })).status).toBe(404);
    const ownerCookie = (await login(app,owner)).cookie;
    expect((await (await app.request('/pouches',{headers:{cookie:ownerCookie}})).json()).length).toBe(pouches.length);
  });
  it('requires both voice secret and wallet-scoped expiring voice credentials', async () => {
    const { app, owner, store } = setup(); process.env.VOICE_WEBHOOK_SECRET = 'test-voice-secret';
    const web = await issueSession(store, owner.publicKey.toBase58());
    const voice = await issueSession(store, owner.publicKey.toBase58(), 'voice', hashToken(web.token));
    const call = (token:string, secret?:string) => app.request('/voice/tools/get_pouches', { method:'POST', headers:{authorization:`Bearer ${token}`, ...(secret ? {'X-Solpouch-Secret':secret} : {})}, body:'{}' });
    expect((await call(web.token,'test-voice-secret')).status).toBe(401);
    expect((await call(voice.token)).status).toBe(401);
    expect((await call(voice.token,'test-voice-secret')).status).toBe(200);
    expect((await app.request('/pouches',{headers:{authorization:`Bearer ${voice.token}`}})).status).toBe(401);
    await store.deleteSession(hashToken(web.token));
    expect((await call(voice.token,'test-voice-secret')).status).toBe(401);
  });
});
