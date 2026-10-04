# Moving production off the laptop

Today solpouch.tech runs on Tariq's laptop: `restart-prod.ps1` starts the backend (`:8787`) and
`next start` (`:3019`), and a Cloudflare tunnel maps `api.solpouch.tech` and `solpouch.tech` to them.
Postgres is already hosted (Tiger Data), so only the two Node processes move.

| Piece | New home | Cost |
|---|---|---|
| Web (`apps/web`) | Vercel Hobby | free, non-commercial use only |
| Backend (`apps/backend`) | Oracle Cloud Always Free VM running `ghcr.io/chrissyafk/solpouch-api` behind Caddy | free |
| Database | Tiger Data (unchanged) | |

Free tiers checked 2026-10-04. Render and Koyeb free tiers sleep when idle and cap at 512 MB / 0.1 CPU,
which drops ElevenLabs tool calls and stops the indexer. Fly.io and Railway have no lasting free tier.
Cloud Run pauses CPU between requests. Fallback if Oracle has no capacity: Northflank Sandbox (always on).

**Vercel Hobby caveat:** its terms forbid commercial use, and accepting payments counts. A devnet demo with
Stripe test mode is fine in spirit. Real payments mean Vercel Pro, or serving the web from the VM as well.

## Rule: never run two backends at once

Every backend start runs the withdrawal payout loop (`apps/backend/src/index.ts:100`) and, with
`ENABLE_INDEXER=true`, the indexer. Two backends on the same database could pay a withdrawal twice.
The laptop backend is stopped **before** the VM gets the real `.env`, and the rollback restarts it only after
the VM container is stopped.

## 1. Oracle VM (backend)

1. Create an Oracle Cloud account (Always Free). Create a VM: Ubuntu 24.04, shape **VM.Standard.A1.Flex**
   with 1 OCPU and 2 GB. If A1 says "out of capacity", try another availability domain or retry later.
   Add your SSH public key. Note the public IP.
2. In the VM's subnet security list, add ingress TCP 80 and 443 from `0.0.0.0/0`.
3. Copy and run the setup script:
   ```bash
   scp deploy/oracle/setup.sh ubuntu@<IP>:
   ssh ubuntu@<IP> 'bash setup.sh'
   scp deploy/oracle/compose.yaml deploy/oracle/Caddyfile ubuntu@<IP>:solpouch/
   ```
4. **Smoke test with a safe config** (mock vault, memory store, no payout risk). On the VM:
   ```bash
   cd ~/solpouch
   printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
   ```
   In Cloudflare DNS add `api-next` → A record → `<IP>`, **DNS only** (grey cloud) so Caddy can get a certificate.
   ```bash
   API_HOST=api-next.solpouch.tech docker compose up -d
   curl https://api-next.solpouch.tech/health      # expect 200
   ```
   The image is multi-arch (amd64 + arm64) from the `docker.yml` workflow; `docker compose pull` picks the right one.

### Idle reclaim

Oracle reclaims Always Free VMs whose 95th-percentile CPU, network **and** memory all stay under 20% for 7 days.
Our CPU and network stay low, so memory is what keeps it alive: on the 2 GB shape, check
`free -m` after a day and keep used memory above 20% (~410 MB). A bigger shape makes reclaim more likely.
Upgrading the account to Pay As You Go keeps the free resources free and is reported to exempt it from
reclaim (not verified here).

## 2. Vercel (web)

1. Import `ChrissyAFK/Solpouch` in Vercel. **Root Directory: `apps/web`** (Vercel detects the pnpm workspace,
   and `transpilePackages` already builds `@solpouch/shared`). Production branch: `main`.
2. Environment variables (Production):
   - `ENABLE_EXPERIMENTAL_COREPACK=1` (root `package.json` pins `pnpm@12.4.1`)
   - `NEXT_PUBLIC_BACKEND_URL=https://api.solpouch.tech` (also in `apps/web/.env.production`)
   - `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_SOLANA_CLUSTER`,
     `NEXT_PUBLIC_SOLANA_RPC_URL`: same values as the laptop's web env
   - `SOLPOUCH_SITE_URL=https://solpouch.tech`, and `SOLPOUCH_ALLOW_INDEXING` if it is set today
   - Do **not** set `SOLPOUCH_DIST_DIR`.
3. Deploy, then check the `*.vercel.app` URL loads. Sign-in won't work there (Google, Privy and the
   backend CORS list only allow solpouch.tech). That's expected.
4. Add domains `solpouch.tech` and `www.solpouch.tech` in the project. Vercel shows the DNS records;
   don't change DNS yet.

## 3. Cutover (about 10 minutes of downtime)

1. Copy the real config to the VM: the backend `.env` (same file the laptop uses) and the keypairs:
   ```bash
   scp Solpouch/.env ubuntu@<IP>:solpouch/.env
   scp Solpouch/.keys/owner.json Solpouch/.keys/agent.json ubuntu@<IP>:solpouch/keys/
   ssh ubuntu@<IP> 'sudo chown 1000:1000 ~/solpouch/keys/* && chmod 600 ~/solpouch/keys/*'
   ```
   In the VM's `.env`, delete `TRUSTED_PROXY_IPS`, `TRUSTED_PROXY_HEADER` and any `OWNER_KEYPAIR_PATH`,
   `AGENT_KEYPAIR_PATH` or `STRIPE_MINT_KEYPAIR_PATH` set to a Windows path (the defaults read `/app/.keys`).
   If `DATABASE_CA_CERT` is set, copy that file too and mount it in `compose.yaml`.
2. **Stop the laptop backend** by PID (never by process name), and disable the "Solpouch Tunnel"
   scheduled task so it doesn't restart.
3. In Cloudflare DNS replace the tunnel records:
   - `api` → A → `<IP>`, DNS only
   - `@` and `www` → the records Vercel showed, DNS only
4. On the VM: `docker compose down && docker compose up -d` (now the default `API_HOST=api.solpouch.tech`).
   Remove the `api-next` DNS record.
5. Check:
   - `curl https://api.solpouch.tech/health` and `https://solpouch.tech/funding` return 200
   - Google sign-in and the Privy wallet load
   - Voice: "milk and eggs under $15", then "pay for it". Both tool calls succeed and the order shows `paid`
   - A Stripe test top-up completes (the webhook URL is unchanged)
   - The Android app opens without the browser bar (`/.well-known/assetlinks.json` is served by the web)

Nothing else changes: ElevenLabs tool URLs, the Stripe webhook, Google and Privy origins and the Android
asset links all use the same hostnames.

**Rollback:** `docker compose down` on the VM, re-enable the tunnel task, run `restart-prod.ps1`,
and point the DNS records back at the tunnel.

## Updating later

- Backend: push to `main` (or tag `v*`). The workflow publishes the image, then on the VM:
  `docker compose pull && docker compose up -d`.
- Web: Vercel deploys every push to `main` automatically.
