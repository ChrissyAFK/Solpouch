# Moving production off the laptop

Today solpouch.tech runs on Tariq's laptop: `restart-prod.ps1` starts the backend (`:8787`) and
`next start` (`:3019`), and a Cloudflare tunnel maps `api.solpouch.tech` and `solpouch.tech` to them.
Postgres is already hosted (Tiger Data, AWS us-east-1), so only the two Node processes move.

The target is a teammate's VPS running everything in Docker (`deploy/vps/`):

| Container | Image | Serves |
|---|---|---|
| `caddy` | `caddy:2` | TLS on 80/443 for `solpouch.tech`, `www.solpouch.tech`, `api.solpouch.tech` |
| `web` | `ghcr.io/chrissyafk/solpouch-web` | Next.js (`Dockerfile.web`) |
| `api` | `ghcr.io/chrissyafk/solpouch-api` | backend (`Dockerfile`) |

Both images are built for amd64 and arm64 by `.github/workflows/docker.yml` on every push to `main`.
The web image bakes in the public client IDs from the repo variables `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
and `NEXT_PUBLIC_PRIVY_APP_ID` (Settings → Secrets and variables → Actions → Variables).

Whoever has root on the VPS can read the backend `.env` and keypairs (devnet and test keys only).

If there were no VPS: free tiers checked 2026-10-04 point to an Oracle Always Free A1 VM
(same compose file). Render and Koyeb sleep and cap at 512 MB / 0.1 CPU; Fly and Railway have no lasting
free tier; Cloud Run pauses CPU between requests; Vercel Hobby forbids commercial use.

## Rule: never run two backends at once

Every backend start runs the withdrawal payout loop (`apps/backend/src/index.ts:100`) and, with
`ENABLE_INDEXER=true`, the indexer. Two backends on the same database could pay a withdrawal twice.
The laptop backend is stopped **before** the server gets the real `.env`, and the rollback restarts it only
after the server's `api` container is stopped.

## 1. Prepare the server

Needs: Debian/Ubuntu, about 1.5 GB free RAM, ports 80 and 443 free, and an SSH login in the `docker` group.
If the server already runs nginx or Caddy on 80/443, drop the `caddy` service, publish `api` on
`127.0.0.1:8787` and `web` on `127.0.0.1:3000`, and add the three hostnames to the existing proxy instead.

```bash
scp deploy/vps/setup.sh deploy/vps/compose.yaml deploy/vps/Caddyfile solpouch@<IP>:
ssh solpouch@<IP> 'bash setup.sh && mv compose.yaml Caddyfile solpouch/'
```

## 2. Smoke test with a safe config

Mock vault and memory store, so no payout risk. In Cloudflare DNS add `api-next` and `next`
(plus `www.next`) → A → `<IP>`, **DNS only** (grey cloud) so Caddy can get certificates. Then:

```bash
ssh solpouch@<IP>
cd ~/solpouch && printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
API_HOST=api-next.solpouch.tech WEB_HOST=next.solpouch.tech docker compose up -d
curl https://api-next.solpouch.tech/health     # 200
curl -I https://next.solpouch.tech/            # 200 (sign-in won't work on this host, expected)
```

## 3. Cutover (about 10 minutes of downtime)

1. Copy the real backend config and keypairs:
   ```bash
   scp Solpouch/.env solpouch@<IP>:solpouch/.env
   scp Solpouch/.keys/owner.json Solpouch/.keys/agent.json solpouch@<IP>:solpouch/keys/
   scp Solpouch/certs/timescale-ca.pem solpouch@<IP>:solpouch/certs/
   ```
   On the server, make the files readable only by the container user (uid 1000) and fix the paths:
   ```bash
   cd ~/solpouch
   chmod 600 .env && chmod 644 certs/* && chmod 600 keys/*
   docker run --rm -v "$PWD/keys:/k" alpine chown 1000:1000 /k/owner.json /k/agent.json
   sed -i -e '/^TRUSTED_PROXY_/d' -e 's#^DATABASE_CA_CERT=.*#DATABASE_CA_CERT=/app/certs/timescale-ca.pem#' .env
   ```
   `OWNER_KEYPAIR_PATH`/`AGENT_KEYPAIR_PATH` stay `.keys/...` (resolved from `/app`). Leave
   `.keys/checkout.json` and `.keys/android/` on the laptop: the backend doesn't read them.
2. **Stop the laptop backend and web** by PID (never by process name), and disable the
   "Solpouch Tunnel" scheduled task so it doesn't restart.
3. In Cloudflare DNS, replace the tunnel records for `@`, `www` and `api` with A → `<IP>`, DNS only.
   Delete the `next`, `www.next` and `api-next` records.
4. On the server: `docker compose down && docker compose up -d` (defaults are the real hostnames).
5. Check:
   - `https://api.solpouch.tech/health` and `https://solpouch.tech/funding` return 200
   - Google sign-in and the Privy wallet load
   - Voice: "milk and eggs under $15", then "pay for it". Both tool calls succeed and the order shows `paid`
   - A Stripe test top-up completes (the webhook URL is unchanged)
   - The Android app opens without the browser bar (`/.well-known/assetlinks.json`)

Nothing else changes: ElevenLabs tool URLs, the Stripe webhook, Google and Privy origins and the Android
asset links all use the same hostnames.

**Rollback:** `docker compose down` on the server, re-enable the tunnel task, run `restart-prod.ps1`,
and point the three DNS records back at the tunnel.

## Updating later

Push to `main` (or tag `v*`). When the "Docker image" workflow finishes, on the server:
`docker compose pull && docker compose up -d`.
