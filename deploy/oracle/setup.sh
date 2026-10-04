#!/usr/bin/env bash
# One-time setup on a fresh Oracle Ubuntu VM (Ampere A1 or x86). Run as the default `ubuntu` user.
set -euo pipefail

# Docker Engine + compose plugin.
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

# Oracle's Ubuntu images block everything but SSH in iptables, even when the
# VCN security list allows it. Open 80/443 and keep the rules across reboots.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save

mkdir -p ~/solpouch/keys
echo "Done. Log out and back in (docker group), then copy compose.yaml, Caddyfile, .env and keys/ into ~/solpouch."
