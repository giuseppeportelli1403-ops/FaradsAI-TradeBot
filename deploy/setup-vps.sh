#!/usr/bin/env bash
# One-shot VPS bootstrap for BetterOpsAI Trading Bot.
# Run ONCE after first SSH to a fresh Ubuntu 22.04 / 24.04 VPS.
#
# What it does:
#   1. System update + essentials (git, build-essential, ufw, fail2ban)
#   2. Node.js 20 LTS via NodeSource
#   3. pm2 installed globally + log rotation configured
#   4. Non-root user `bot` with a home directory for the repo
#   5. UFW firewall: allow SSH only (bot only makes outbound calls)
#   6. fail2ban on default SSH config
#
# Intended flow:
#   ssh root@<vps-ip>
#   curl -fsSL https://<raw-url-of-this-file> -o setup.sh    # OR scp it over
#   chmod +x setup.sh
#   ./setup.sh
#   su - bot                                                 # switch to bot user
#   # then follow DEPLOY.md from step 4 onwards

set -euo pipefail

log() { printf '\n\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

if [[ "${EUID}" -ne 0 ]]; then
  warn "This script must run as root. Try: sudo ./setup-vps.sh"
  exit 1
fi

log "1/6 — apt update + upgrade"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git build-essential ufw fail2ban unattended-upgrades

log "2/6 — Node.js 20 LTS via NodeSource"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

log "3/6 — pm2 + log rotation"
npm install -g pm2@latest
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

log "4/6 — create non-root user 'bot'"
if ! id -u bot >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' bot
  # Copy root's authorized_keys so Giuseppe can SSH in as bot with the same key
  if [[ -f /root/.ssh/authorized_keys ]]; then
    mkdir -p /home/bot/.ssh
    cp /root/.ssh/authorized_keys /home/bot/.ssh/authorized_keys
    chown -R bot:bot /home/bot/.ssh
    chmod 700 /home/bot/.ssh
    chmod 600 /home/bot/.ssh/authorized_keys
  fi
fi
# Allow bot to run pm2 — no sudo needed for pm2 itself, only for pm2 startup
# (which we'll run as root below to register the systemd unit).

log "5/6 — firewall + fail2ban"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

systemctl enable --now fail2ban

log "6/6 — unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

log "✅ VPS bootstrapped."
printf '\nNext steps (as root, once):\n'
printf '  pm2 startup systemd -u bot --hp /home/bot    # prints a command; run it\n\n'
printf 'Then switch user and follow DEPLOY.md:\n'
printf '  su - bot\n'
printf '  git clone <your-repo-url> trading-bot\n'
printf '  cd trading-bot && npm ci && npm run build\n'
printf '  # scp your .env into ./ from your laptop\n'
printf '  pm2 start ecosystem.config.cjs\n'
printf '  pm2 save\n'
