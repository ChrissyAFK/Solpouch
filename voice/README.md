# Voice agent (ElevenLabs)

The Solpouch voice agent is configured in the ElevenLabs dashboard (Agents). This folder holds its prompt and tool definitions so they're versioned with the code.

## Setup

1. ElevenLabs → Agents → create agent "Solpouch".
2. **LLM:** a Gemini model (pick it in the agent's LLM settings).
3. **System prompt:** paste `prompt.md`.
4. **First message:** "Hey, it's Solpouch. What do you need?"
5. **Tools:** add each entry in `tools.json` as a **server tool** (webhook), `POST {BACKEND_PUBLIC_URL}/voice/tools/<name>`, with header `X-Solpouch-Secret: <ELEVENLABS_TOOL_SECRET>`.
6. The backend must be reachable from the internet for webhooks. During development, expose it with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787` or ngrok) and use that URL.

Every tool response includes a `say` string. The agent should read it, not rephrase prices or quantities.

## Rule that must never change

There is **no tool** to top up a pouch, withdraw, or move money between pouches. Those are owner-only, in the app, on purpose. Don't add one.

## Signed-in user binding (required)

The frontend first calls authenticated `POST /auth/voice-token`, which returns
`{ token, expiresAt }`. This fifteen-minute credential is tied to the persisted
Google login session. Signing out, revoking that device, signing out all devices,
or expiry invalidates its tools immediately. The browser closes its conversation
when accounts change. A voice token cannot authenticate normal account APIs.

The current frontend supplies a dynamic variable named `user_token`. Configure
**every** ElevenLabs server tool to insert that value into its JSON body as
`user_token` using a fixed dynamic-variable binding. Do not make this a value the
language model invents or asks the user to dictate. The older tool schema alone
is insufficient: a webhook without this credential returns 401. The shared
`X-Solpouch-Secret` header must still come from an ElevenLabs workspace secret.
Keep `ELEVENLABS_TOOL_SECRET` configured; production refuses tools without it.

The backend also accepts `Authorization: Bearer <voice token>`. If a header is
present it takes precedence, so an invalid header cannot be rescued by a body
credential. A coordinated provider/frontend upgrade can use the secret-prefixed
variable `secret__solpouch_voice_token` containing the whole Bearer value and map
it to `Authorization` with `{ "variable_name": "secret__solpouch_voice_token" }`.
Map the shared header with `{ "secret_id": "<workspace secret id>" }`. Do not
change just one side of that contract. This repository change does not modify
any live agent, and does not claim that the live provider uses secret redaction.
The public-agent connection is preserved pending that coordinated migration.

## Backend deployment and validation

Use a persistent `DATABASE_URL` for revocable sessions and shared rate limits.
Memory mode is a local fixture: all sessions and counters disappear on restart.
Set `SESSION_SECRET` to at least 32 random bytes and keep it consistent across
instances. Existing stateless login tokens from older releases require sign-in
again after this migration. The session store contains IDs and public Google
profile fields; it never stores bearer tokens.

Only explicitly trusted socket peers may supply forwarding headers. Configure
`TRUSTED_PROXY_IPS` and `TRUSTED_PROXY_HEADER` for the actual ingress. Restrict the
backend listener at the network/proxy layer. Header presence is not proof of
Cloudflare traffic; the previous `PUBLIC_API` header-based tunnel guard has been
removed. All private routes still require their normal credentials.

AI order creation (including voice) and text chat share per-account limits of
10 operations/minute and 200/day in the store. Generic IP limits also apply.
Rate-limit storage failure rejects requests with 503 rather than bypassing the
budget. A blocked request returns 429 with `Retry-After`.

Test with two users: verify ownership, reject web tokens at voice tools, revoke
one session without affecting another, and confirm that logout makes old voice
calls fail. Check the five actual provider tool mappings in a test agent before
production. Local mocked tests prove application behavior, not provider setup.
