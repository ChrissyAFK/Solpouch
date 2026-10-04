// Run with WEB_TEST_URL pointing to a running web server and Playwright installed.
// All backend and ElevenLabs traffic is intercepted: these are identity-isolation
// regressions, not proof of live Google sign-in, microphone, or agent integration.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'chrome', headless: true });
after(() => browser.close());
const origin = process.env.WEB_TEST_URL ?? 'http://localhost:3004';
const key = 'solpouch.session';
const a = { token: 'fixture-a', user: { email: 'a@example.test', name: 'Alice' } };
const b = { token: 'fixture-b', user: { email: 'b@example.test', name: 'Bob' } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, handle) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(({ key, a }) => localStorage.setItem(key, JSON.stringify(a)), { key, a });
  await page.route('**/auth/**', route => new URL(route.request().url()).pathname === '/auth/logout' ? route.fulfill({ json: { ok: true } }) : handle(route));
  await page.route('**/auth/voice-status', route => route.fulfill({ json: { enabled: true } }));
  await page.route('**/pouches', route => route.fulfill({ json: [] }));
  await page.route('**/orders', route => route.fulfill({ json: [] }));
  return page;
}
async function switchAccount(page, session) {
  await page.evaluate(({ key, session }) => {
    const oldValue = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify(session));
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: JSON.stringify(session), storageArea: localStorage }));
  }, { key, session });
  await page.getByRole('link', { name: 'Profile', exact: true }).filter({ hasText: session.user.name }).waitFor();
}
for (const status of [200, 401]) {
  test(`late auth/me ${status} cannot undo logout or overwrite another account`, async t => {
    const held = deferred(); const arrived = deferred();
    const page = await setup(t, async route => {
      arrived.resolve(); await held.promise;
      await route.fulfill({ status, json: { user: a.user } }).catch(() => {});
    });
    await page.goto(`${origin}/dashboard`); await arrived.promise;
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForFunction(key => localStorage.getItem(key) === null, key);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    await switchAccount(page, b); held.resolve();
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), b);
  });
}
test('pending voice token is cancelled and old chat disappears on account change', async t => {
  const held = deferred(); const arrived = deferred(); let requests = 0; const headers = [];
  const page = await setup(t, async route => {
    if (new URL(route.request().url()).pathname === '/auth/me') return route.fulfill({ json: { user: a.user } });
    headers.push(route.request().headers().authorization); requests++;
    if (requests === 1) { arrived.resolve(); await held.promise; }
    await route.fulfill({ json: { token: `voice-${requests}` } }).catch(() => {});
  });
  const sockets = [];
  await page.routeWebSocket(/api\.elevenlabs\.io/, ws => { sockets.push(ws); });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Solpouch' }).fill('Private Alice message');
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await arrived.promise;
  await switchAccount(page, b); held.resolve();
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  assert.equal(await page.getByText('Private Alice message', { exact: true }).count(), 0);
  await page.waitForTimeout(250); assert.equal(sockets.length, 0);
  await page.getByRole('textbox', { name: 'Message Solpouch' }).fill('Bob message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent.includes('Bob message'));
  for (let i = 0; i < 30 && requests < 2; i++) await page.waitForTimeout(100);
  assert.deepEqual(headers, ['Bearer fixture-a', 'Bearer fixture-b']);
});
test('connected agent closes and history clears when account changes', async t => {
  const page = await setup(t, route => route.fulfill({ json: new URL(route.request().url()).pathname === '/auth/me' ? { user: a.user } : { token: 'voice-a', signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture', expiresAt: new Date(Date.now()+60000).toISOString() } }));
  const connected = deferred(); const closed = deferred(); const received = [];
  await page.routeWebSocket(/api\.elevenlabs\.io/, ws => {
    ws.onClose(() => closed.resolve());
    ws.onMessage(raw => {
      const message = JSON.parse(raw); received.push(message);
      if (message.type === 'conversation_initiation_client_data') {
        ws.send(JSON.stringify({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'fixture-conversation', agent_output_audio_format: 'pcm_16000', user_input_audio_format: 'pcm_16000' } }));
      }
      if (message.type === 'user_message') {
        ws.send(JSON.stringify({ type: 'agent_response', agent_response_event: { agent_response: 'Private Alice answer' } }));
        connected.resolve();
      }
    });
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Solpouch' }).fill('Alice question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await Promise.race([connected.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture agent did not connect')), 10000))]);
  await page.getByText('Private Alice answer', { exact: true }).waitFor();
  await switchAccount(page, b);
  await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Old connection stayed open')), 5000))]);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  assert.equal(await page.getByText('Private Alice answer', { exact: true }).count(), 0);
  assert.equal(received.find(m => m.type === 'conversation_initiation_client_data').dynamic_variables.secret__solpouch_voice_token, 'Bearer voice-a');
});
test('late successful auth restore leaves signed-out storage empty', async t => {
  const held = deferred(); const arrived = deferred();
  const page = await setup(t, async route => {
    arrived.resolve(); await held.promise;
    await route.fulfill({ json: { user: a.user } }).catch(() => {});
  });
  await page.goto(`${origin}/dashboard`); await arrived.promise;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  held.resolve(); await page.waitForTimeout(250);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
  assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
});
test('a previous account API 401 cannot sign out the new account', async t => {
  const held = deferred(); const arrived = deferred();
  const page = await setup(t, route => route.fulfill({ json: { user: a.user } }));
  await page.route('**/pouches', async route => {
    if (route.request().headers().authorization !== 'Bearer fixture-a') return route.fulfill({ json: [] });
    arrived.resolve(); await held.promise;
    await route.fulfill({ status: 401, json: { error: 'Expired fixture' } }).catch(() => {});
  });
  await page.goto(`${origin}/dashboard`); await arrived.promise;
  await switchAccount(page, b); held.resolve(); await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), b);
});
test('connection completing after account change never sends the queued message', async t => {
  const page = await setup(t, route => route.fulfill({ json: new URL(route.request().url()).pathname === '/auth/me' ? { user: a.user } : { token: 'voice-a', signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture', expiresAt: new Date(Date.now()+60000).toISOString() } }));
  const started = deferred(); const closed = deferred(); const received = []; let socket;
  await page.routeWebSocket(/api\.elevenlabs\.io/, ws => {
    socket = ws;
    ws.onClose(() => closed.resolve());
    ws.onMessage(raw => { const message = JSON.parse(raw); received.push(message); if (message.type === 'conversation_initiation_client_data') started.resolve(); });
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Solpouch' }).fill('Never send after logout');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Socket did not start')), 10000))]);
  await switchAccount(page, b);
  socket.send(JSON.stringify({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'late-fixture', agent_output_audio_format: 'pcm_16000', user_input_audio_format: 'pcm_16000' } }));
  await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Late socket stayed open')), 5000))]);
  assert.equal(received.some(m => m.type === 'user_message'), false);
});
test('closing Talk cancels a pending voice token before the SDK starts', async t => {
  const held = deferred(); const arrived = deferred();
  const page = await setup(t, async route => {
    if (new URL(route.request().url()).pathname === '/auth/me') return route.fulfill({ json: { user: a.user } });
    arrived.resolve(); await held.promise;
    await route.fulfill({ json: { token: 'cancelled-voice-token' } }).catch(() => {});
  });
  await page.addInitScript(() => {
    navigator.permissions.query = async () => ({ state: 'granted' });
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  });
  const sockets = [];
  await page.routeWebSocket(/api\.elevenlabs\.io/, ws => sockets.push(ws));
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('button', { name: 'Talk', exact: true }).click(); await arrived.promise;
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  held.resolve(); await page.waitForTimeout(250);
  assert.equal(sockets.length, 0);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('button', { name: 'Talk', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Ask Solpouch' }).getByRole('alert').count(), 0);
});
test('repeated Talk while permission is pending starts once; closing releases the late stream', async t => {
  let tokenRequests = 0;
  const page = await setup(t, route => {
    if (new URL(route.request().url()).pathname === '/auth/me') return route.fulfill({ json: { user: a.user } });
    tokenRequests++; return route.fulfill({ json: { token: 'must-not-be-requested' } });
  });
  await page.addInitScript(() => {
    window.fixtureMicrophoneCalls = 0; window.fixtureTracksStopped = 0;
    navigator.permissions.query = async () => ({ state: 'granted' });
    navigator.mediaDevices.getUserMedia = () => {
      window.fixtureMicrophoneCalls++;
      return new Promise(resolve => { window.releaseFixtureMicrophone = () => resolve({ getTracks: () => [{ stop() { window.fixtureTracksStopped++; } }] }); });
    };
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  await page.waitForFunction(() => window.fixtureMicrophoneCalls === 1);
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureMicrophoneCalls), 1);
  await page.getByRole('button', { name: 'Close chat', exact: true }).click();
  await page.evaluate(() => window.releaseFixtureMicrophone());
  await page.waitForFunction(() => window.fixtureTracksStopped === 1);
  assert.equal(tokenRequests, 0);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('button', { name: 'Talk', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Ask Solpouch' }).getByRole('alert').count(), 0);
});
test('sign-out closes an active conversation before delayed server revocation completes', async t => {
  const held = deferred(); const revoking = deferred(); const closed = deferred(); const connected = deferred();
  const page = await setup(t, route => route.fulfill({ json: new URL(route.request().url()).pathname === '/auth/me' ? { user: a.user } : { token: 'voice-a', signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=fixture', expiresAt: new Date(Date.now()+60000).toISOString() } }));
  await page.route('**/auth/logout', async route => { revoking.resolve(); await held.promise; await route.fulfill({ json: { ok: true } }).catch(() => {}); });
  await page.routeWebSocket(/api\.elevenlabs\.io/, ws => {
    ws.onClose(() => closed.resolve());
    ws.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'conversation_initiation_client_data') ws.send(JSON.stringify({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'logout-fixture', agent_output_audio_format: 'pcm_16000', user_input_audio_format: 'pcm_16000' } }));
      if (message.type === 'user_message') connected.resolve();
    });
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole('button', { name: 'Ask Solpouch', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message Solpouch' }).fill('Alice question');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await Promise.race([connected.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture did not connect')), 10000))]);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await revoking.promise;
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
  await Promise.race([closed.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Conversation remained active while logout waited')), 5000))]);
  await page.getByRole('heading', { name: 'Sign in to Solpouch', exact: true }).waitFor();
  held.resolve();
});
