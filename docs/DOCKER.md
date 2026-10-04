# Backend API Docker image

Image: `ghcr.io/chrissyafk/solpouch-api:1.1.0`. It runs `tsx src/index.ts` as the non-root `node` user and listens on 8787. No secrets are baked in; `.env*` and `.keys` are excluded by `.dockerignore`. Configure everything with `-e` or `--env-file` at run time.

## Build

    docker build -t solpouch-api:1.1.0 .

## Run (demo-safe, no secrets)

Memory store and mock vault: leave `VAULT_MODE` and `DATABASE_URL` unset.

    docker run -d --name solpouch-api -p 8787:8787 \
      -e SESSION_SECRET=$(openssl rand -hex 32) \
      -e WEB_ORIGINS=http://localhost:3000 \
      solpouch-api:1.1.0
    curl http://localhost:8787/health

`NODE_ENV=production` is set, so sign-in refuses to work without `SESSION_SECRET` (the server still boots and serves /health). Data is lost on restart in this mode. Do not set `DATABASE_URL` in mock mode; the server refuses.

## Real setup (names only)

- Required for chain mode: `VAULT_MODE=chain`, `DATABASE_URL`, `VAULT_PROGRAM_ID`, `TEST_USDC_MINT`, `SOLANA_RPC_URL`, `SESSION_SECRET`, `CHECKOUT_PAY_TO`, and keypairs mounted as files with `OWNER_KEYPAIR_PATH` / `AGENT_KEYPAIR_PATH` (mount with `-v`, never bake in).
- Auth: `GOOGLE_CLIENT_ID`, `PRIVY_JWT_PRIVATE_KEY`, `WEB_ORIGINS`.
- AI: `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`.
- Voice: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `VOICE_WEBHOOK_SECRET` (or `ELEVENLABS_TOOL_SECRET`), `ELEVENLABS_SECURE_TOOLS_CONFIGURED=true`. Production refuses voice tool calls without the secret.
- Optional: `BACKEND_PORT`, `FUNDING_DATABASE_URL`, `STRIPE_SECRET_KEY`, `INSTACART_API_KEY`, `DATABASE_CA_CERT`, `TRUSTED_PROXY_IPS`.

## Pull

    docker pull ghcr.io/chrissyafk/solpouch-api:1.1.0
