#!/usr/bin/env bash
# One-time setup on the server (Debian/Ubuntu). Needs sudo; skips anything already done.
set -euo pipefail

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Log out and back in so the docker group applies."
fi

# Oracle's Ubuntu images block everything but SSH in iptables; open 80/443 there only.
if [ -f /etc/oracle-cloud-agent/agent.yml ] || grep -qi oracle /sys/class/dmi/id/chassis_asset_tag 2>/dev/null; then
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
  sudo apt-get install -y iptables-persistent
  sudo netfilter-persistent save
fi

# ufw, if enabled, must allow web traffic.
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi

mkdir -p ~/solpouch/keys
echo "Ready. Copy compose.yaml, Caddyfile, .env and keys/ into ~/solpouch."
