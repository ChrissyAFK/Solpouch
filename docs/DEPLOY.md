# Moving production off the laptop

**Done 2026-10-04:** solpouch.tech now runs on the VPS below. The laptop's "Solpouch Tunnel" task is
disabled and its backend and web are stopped; the steps are kept for rollback and for reference.

Before the cutover, solpouch.tech ran on Tariq's laptop: `restart-prod.ps1` starts the backend (`:8787`) and
`next start` (`:3019`), and a Cloudflare tunnel maps `api.solpouch.tech` and `solpouch.tech` to them.
Postgres is already hosted (Tiger Data, AWS us-east-1), so only the two Node processes move.

The target is a teammate's VPS (`tariq@5.78.87.188`, x86_64, Ubuntu 24.04, about 2 GB RAM free).
It already runs a shared Caddy, `shared-automation-proxy-1`, that owns ports 80/443 and reads
`/opt/trading-os/infra/shared/Caddyfile`. Solpouch adds two containers (`deploy/vps/compose.yaml`) on that
proxy's `trading-os-edge` network and publishes no host ports (8787 and 3000 are already taken):

| Container | Image | Proxy reaches it as |
|---|---|---|
| `web` | `ghcr.io/chrissyafk/solpouch-web` (`Dockerfile.web`) | `solpouch-web:3000` |
| `api` | `ghcr.io/chrissyafk/solpouch-api` (`Dockerfile`) | `solpouch-api:8787` |

The site blocks for the shared Caddyfile are in `deploy/vps/Caddyfile`. Editing that file and reloading the
proxy is the teammate's call, since other projects share it.

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

```bash
ssh tariq@5.78.87.188 'mkdir -p ~/solpouch/keys ~/solpouch/certs'
scp deploy/vps/compose.yaml tariq@5.78.87.188:solpouch/
# The proxy's address on trading-os-edge, for the rate limiter's trusted-proxy check:
ssh tariq@5.78.87.188 "docker inspect shared-automation-proxy-1 --format '{{(index .NetworkSettings.Networks \"trading-os-edge\").IPAddress}}'"
# 172.20.0.3 as of 2026-10-04; re-check if the proxy container is recreated.
```

The server has no swap; 2 GB of it keeps a memory spike from killing containers
(`sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`,
plus `/swapfile none swap sw 0 0` in `/etc/fstab`). Ask the teammate first.

A `solpouch-smoke` stack (`/opt/solpouch`) already runs there. If it uses the real database, it must be
stopped before the cutover (rule above).

## 2. Smoke test with a safe config

Mock vault and memory store, so no payout risk. In Cloudflare DNS add `api-next` and `next`
(plus `www.next`) → A → `5.78.87.188`, **DNS only** (grey cloud) so Caddy can get certificates.
The teammate appends `deploy/vps/Caddyfile` to the shared Caddyfile with the hosts swapped to
`api-next.solpouch.tech` and `next.solpouch.tech, www.next.solpouch.tech`, then reloads the proxy
(`docker exec shared-automation-proxy-1 caddy reload --config /etc/caddy/Caddyfile`). Then:

```bash
ssh tariq@5.78.87.188
cd ~/solpouch && printf 'SESSION_SECRET=%s\nPROXY_IP=172.20.0.3\n' "$(openssl rand -hex 32)" > .env
docker compose up -d
curl https://api-next.solpouch.tech/health     # 200
curl -I https://next.solpouch.tech/            # 200 (sign-in won't work on this host, expected)
```

## 3. Cutover (about 10 minutes of downtime)

1. Copy the real backend config and keypairs:
   ```bash
   scp Solpouch/.env tariq@5.78.87.188:solpouch/.env
   scp Solpouch/.keys/owner.json Solpouch/.keys/agent.json tariq@5.78.87.188:solpouch/keys/
   scp Solpouch/certs/timescale-ca.pem tariq@5.78.87.188:solpouch/certs/
   ```
   On the server, make the files readable only by the container user (uid 1000) and fix the paths:
   ```bash
   cd ~/solpouch
   chmod 600 .env && chmod 644 certs/* && chmod 600 keys/*
   docker run --rm -v "$PWD/keys:/k" alpine chown 1000:1000 /k/owner.json /k/agent.json
   sed -i -e '/^TRUSTED_PROXY_/d' -e 's#^DATABASE_CA_CERT=.*#DATABASE_CA_CERT=/app/certs/timescale-ca.pem#' .env
   echo 'PROXY_IP=172.20.0.3' >> .env
   ```
   `OWNER_KEYPAIR_PATH`/`AGENT_KEYPAIR_PATH` stay `.keys/...` (resolved from `/app`). Leave
   `.keys/checkout.json` and `.keys/android/` on the laptop: the backend doesn't read them.
2. **Stop the laptop backend and web** by PID (never by process name), and disable the
   "Solpouch Tunnel" scheduled task so it doesn't restart.
3. In Cloudflare DNS, replace the tunnel records for `@`, `www` and `api` with A → `5.78.87.188`, DNS only.
   Delete the `next`, `www.next` and `api-next` records.
4. The teammate switches the Solpouch blocks in the shared Caddyfile to the real hosts (as in
   `deploy/vps/Caddyfile`) and reloads the proxy. Do this after DNS points at the server: Caddy backs off
   after failed certificate attempts, and `caddy reload --force` makes it retry at once (about a minute).
   In Cloudflare, a Tunnel record's type can be changed to A in place from its Edit form.
5. On the server: `docker compose down && docker compose up -d`.
6. Check:
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
