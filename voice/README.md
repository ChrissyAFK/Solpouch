> Hardened API: the shared secret alone no longer authorizes tools. Each call also needs `Authorization: Bearer <voice-token>` from an authenticated wallet session. Tokens expire after five minutes and depend on the parent web session. Direct browser voice is disabled until conversation binding is implemented. See [backend hardening](../BACKEND-HARDENING.md). The setup below is historical and is insufficient on its own.

# Voice agent (ElevenLabs)

The Solpouch voice agent is configured in the ElevenLabs dashboard (Agents). This folder holds its prompt and tool definitions so they're versioned with the code.

## Setup

1. ElevenLabs → Agents → create agent "Solpouch".
2. **LLM:** a Gemini model (pick it in the agent's LLM settings).
3. **System prompt:** paste `prompt.md`.
4. **First message:** "Hey, it's Solpouch. What do you need?"
5. **Tools:** add each entry in `tools.json` as a **server tool** (webhook), `POST {BACKEND_PUBLIC_URL}/voice/tools/<name>`, with header `X-Solpouch-Secret: <VOICE_WEBHOOK_SECRET>`.
6. The backend must be reachable from the internet for webhooks. During development, expose it with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8787` or ngrok) and use that URL.

Every tool response includes a `say` string. The agent should read it, not rephrase prices or quantities.

## Rule that must never change

There is **no tool** to top up a pouch, withdraw, or move money between pouches. Those are owner-only, in the app, on purpose. Don't add one.

## Secure signed sessions on the backend-hardening branch

This branch combines Google account sessions with verified linked wallets. Configure and verify a private test agent before enabling production. Source integration alone does not change the live ElevenLabs agent.

The authenticated browser calls `POST /auth/voice-session`. The backend requests a signed WebSocket URL from ElevenLabs using `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. It also returns a five-minute voice-only token linked to the browser session. Neither the provider API key nor the shared tool secret is sent to the browser. Logout or expiry invalidates the token at every tool request. The widget stops the conversation on close, unmount, cancellation, and token expiry. Talk requests microphone access only after a click; text mode does not request it.

Before enabling the bridge, configure a **private** test agent that requires authentication. Configure every server tool using `session-config.example.json`: `Authorization` must bind to the dynamic variable `secret__solpouch_voice_token` (the variable value already includes `Bearer `). Configure `X-Solpouch-Secret` with a workspace secret resource whose value matches backend `VOICE_WEBHOOK_SECRET` (legacy `ELEVENLABS_TOOL_SECRET` is accepted). Do not interpolate a token into a prompt or tool body. ElevenLabs secret-prefixed dynamic variables are excluded from the LLM prompt and redacted from logs.

Set server environment variables:

```
ELEVENLABS_API_KEY=<server-only key>
ELEVENLABS_AGENT_ID=<private test agent id>
VOICE_WEBHOOK_SECRET=<shared workspace secret value>
ELEVENLABS_SECURE_TOOLS_CONFIGURED=true
```

Leave the final flag unset until all tools have the two header bindings. No public-agent-id fallback exists. If configuration or the provider is unavailable, authenticated read-only Gemini/demo text chat remains available. An agent session may use the configured pouch tools, including payment actions within pouch rules; the fallback helper cannot do that. Do not auto-replay a tool action after a live agent disconnects.

Test with two owners: each conversation sees only its owner's pouches; an absent/wrong header must fail; a web token cannot call voice tools; voice tokens cannot call normal APIs; logout and five-minute expiry must stop tool access. The local backend test uses a mocked signed URL and is not evidence of a successful provider session. A real microphone conversation and private-agent header mapping still require external verification before enabling production.

Provider references: [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react), [dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables), [authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication).

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

Cart edits require fresh approval. The `confirm_order` tool must send the `version` returned with the reviewed cart. Update the provider tool schema from `tools.json` before using edited carts in voice. A missing or stale version cannot authorize a draft payment. This repository change does not update the live provider agent.
