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
