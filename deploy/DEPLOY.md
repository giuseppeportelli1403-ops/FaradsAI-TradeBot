# VPS Deployment Runbook — BetterOpsAI Trading Bot

**Target:** a fresh Ubuntu 22.04 or 24.04 VPS (Hetzner CX22 / CPX11 recommended, ~€4.50/mo). Bot runs under pm2 as a non-root user, makes outbound calls only (no inbound ports beyond SSH).

**Time budget:** ~45 minutes end-to-end, most of which is Hetzner's signup + VM provisioning.

**Estimated monthly cost:** €4.50 (VPS) + 0 (free API tiers you already have).

---

## Phase 1 — Provision the VPS (Hetzner)

### 1.1 Sign up / log in
1. Go to https://accounts.hetzner.com/signUp
2. Create account, verify email, add a payment method (card or SEPA)
3. Open **Hetzner Cloud** console: https://console.hetzner.cloud/

### 1.2 Add your SSH key (do this BEFORE creating the server)
1. On your **laptop** (Git Bash), check if you already have a key:
   ```bash
   ls ~/.ssh/id_ed25519.pub
   ```
2. If not, generate one:
   ```bash
   ssh-keygen -t ed25519 -C "giuseppeportelli1403@gmail.com"
   # press Enter to accept defaults, set a passphrase (recommended)
   ```
3. Print the public key:
   ```bash
   cat ~/.ssh/id_ed25519.pub
   ```
4. In Hetzner console → **Security** → **SSH Keys** → **Add SSH Key** → paste the public key → name it "laptop".

### 1.3 Create the server
1. Hetzner console → **Projects** → create new project "BetterOpsAI" (or reuse existing)
2. Inside project → **Servers** → **Add Server**
3. Settings:
   - **Location:** Falkenstein (eu-central) or Helsinki — either is fine, <50ms to Malta
   - **Image:** Ubuntu 24.04 (or 22.04 if you prefer LTS with more maturity)
   - **Type:** CX22 (shared x86, 2 vCPU, 4 GB RAM, 40 GB disk) — overkill but cheapest reliable tier
   - **Networking:** IPv4 + IPv6 (defaults)
   - **SSH Keys:** check your "laptop" key
   - **Name:** `trading-bot-prod`
   - **Firewall:** skip (we install UFW on the server itself)
   - **Backups:** optional, +20% cost — worth it for €1/mo if you care
4. Click **Create & Buy Now**. Server is provisioned in ~30 seconds. Note its **IPv4 address**.

### 1.4 First SSH
From your laptop:
```bash
ssh root@<vps-ip>
# accept the fingerprint, type "yes"
```
You should land in the VPS shell as root. If this fails, revisit SSH key setup — likely the key isn't added to Hetzner or your agent isn't loading it.

---

## Phase 2 — Bootstrap the server (one-shot script)

### 2.1 Copy the setup script up
From your **laptop** (keep the SSH session above open in another terminal tab):
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot"
scp deploy/setup-vps.sh root@<vps-ip>:/root/
```

### 2.2 Run it on the VPS
In the VPS SSH session:
```bash
chmod +x /root/setup-vps.sh
/root/setup-vps.sh
```
Takes ~3–5 min. Installs Node 20, pm2, creates a `bot` user, configures UFW + fail2ban + unattended upgrades.

### 2.3 Register pm2 startup (runs as root, once)
After the script finishes:
```bash
pm2 startup systemd -u bot --hp /home/bot
```
That command prints ANOTHER command — copy-paste and run it. It installs a systemd unit so pm2 (and the bot) come back after a VPS reboot.

---

## Phase 3 — Get the code onto the VPS

### 3.1 Push your local repo to a private GitHub repo
On your **laptop**:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot"

# If you haven't already, install GitHub CLI: https://cli.github.com/
gh auth login          # follow prompts; pick HTTPS + web flow

# Create the private repo and push
gh repo create betterops-trading-bot --private --source=. --remote=origin
git push -u origin master
```
Note the repo URL it prints (e.g. `https://github.com/<you>/betterops-trading-bot`).

### 3.2 Generate a deploy key for the VPS (read-only access to the repo)
From the VPS as root (or as `bot` after switching):
```bash
su - bot                        # switch to bot user
ssh-keygen -t ed25519 -C "bot@trading-bot-prod" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copy the output.

### 3.3 Add the deploy key to GitHub
On GitHub: navigate to your `betterops-trading-bot` repo → **Settings** → **Deploy keys** → **Add deploy key** → paste the VPS public key → name it "trading-bot-prod VPS" → **NO** write access → Add.

### 3.4 Clone on the VPS (as `bot` user)
Still as `bot`:
```bash
cd ~
git clone git@github.com:<you>/betterops-trading-bot.git trading-bot
cd trading-bot
npm ci                # clean install, reproducible from package-lock.json
npm run build         # compiles TS to dist/
npm test              # sanity: should be 101/101 green on the VPS too
```

---

## Phase 4 — Secrets

### 4.1 Copy `.env` from laptop to VPS (scp)
From your **laptop**:
```bash
cd "/c/Users/user/Desktop/Trade Bot/Trade Bot"
scp .env bot@<vps-ip>:~/trading-bot/.env
```

### 4.2 Verify on the VPS
```bash
ssh bot@<vps-ip>
cd ~/trading-bot
ls -la .env                    # must show permissions 600 (or chmod 600 .env)
chmod 600 .env                 # belt-and-braces
```

**Sanity check without revealing values:**
```bash
awk -F= '/^[A-Z]/ { print $1, "set (" length(substr($0,length($1)+2)) " chars)" }' .env
```
Should show CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_API_KEY_PASSWORD, CAPITAL_API_URL, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, plus the 5 market-data keys. `CAPITAL_API_URL` must contain `demo-api-capital` — NOT the live URL.

---

## Phase 5 — Start the bot under pm2

As `bot` on the VPS, in `~/trading-bot`:
```bash
pm2 start ecosystem.config.cjs
pm2 save                        # persist the running process list
pm2 status                      # should show trading-bot | online | 0 restarts
pm2 logs trading-bot --lines 50
```
Expected log tail:
```
[OK] Preflight checks passed.
[OK] Database initialised.
[OK] Telegram initialised.
[OK] Scheduler running. Bot is live.
```

---

## Phase 6 — Verify the 24h keep-alive works

1. Let it run ~16 minutes (covers 2 full ping cycles of the `*/8 * * * *` cron).
2. From the VPS:
   ```bash
   pm2 logs trading-bot --lines 200 | grep -i "ping" || echo "no ping activity logged (expected — ping is silent on success)"
   ```
   The absence of `Capital ping failed` is the signal. Ping successes don't log.
3. Verify no Telegram alerts arrived in your `@farad_tradingbot` chat.
4. Quick liveness check (doesn't interfere with the bot):
   ```bash
   # Count bot process age in seconds
   pm2 describe trading-bot | grep -E "uptime|restarts"
   ```
   Uptime should grow monotonically; restarts should stay at 0.
5. Leave it running. Step 13 (2-week demo) starts now.

---

## Common operations

```bash
pm2 status                           # overview
pm2 logs trading-bot                 # live tail
pm2 logs trading-bot --err           # errors only
pm2 restart trading-bot              # graceful restart (10s shutdown window)
pm2 stop trading-bot                 # stop without removing from pm2's list
pm2 delete trading-bot               # remove from pm2 entirely
pm2 monit                            # interactive CPU/mem monitor
```

### Deploying an update
```bash
# On laptop
git push                              # your new commits

# On VPS
ssh bot@<vps-ip>
cd ~/trading-bot
git pull
npm ci
npm run build
npm test                              # refuse to restart if tests fail
pm2 restart trading-bot
```

### Killing a stuck position remotely
```bash
ssh bot@<vps-ip>
cd ~/trading-bot
# interactive Node REPL with client loaded:
node --env-file=.env --input-type=module -e "
import { CapitalClient } from './dist/mcp-server/capital-client.js';
const c = new CapitalClient({
  apiKey: process.env.CAPITAL_API_KEY,
  identifier: process.env.CAPITAL_IDENTIFIER,
  password: process.env.CAPITAL_API_KEY_PASSWORD,
  baseURL: process.env.CAPITAL_API_URL,
});
const ps = await c.getOpenPositions();
console.log(JSON.stringify(ps, null, 2));
for (const p of ps) await c.closePosition(p.position.dealId);
await c.logout();
"
```

---

## Security notes

- SSH as `root` is fine initially; for hardening, later edit `/etc/ssh/sshd_config`, set `PermitRootLogin no` and `PasswordAuthentication no`, then `systemctl reload sshd`.
- `.env` must be `chmod 600` and owned by `bot`. Never commit it.
- `ANTHROPIC_API_KEY` and Capital API keys give trading authority — leak = real loss even on demo (throttles, abuse). Rotate if any shell history on a shared machine leaks them.
- `CAPITAL_API_URL` must contain `demo-api-capital`. The preflight `LIVE_TRADING_OK=true` gate refuses to start on the live URL without explicit opt-in — but one confused `export` could still bypass it. Check the value before every `pm2 restart`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm ci` fails with peer-dep error | Node version mismatch | Confirm `node -v` is `v20.x`. Re-run setup script if not. |
| `pm2 start` succeeds but bot exits immediately | Missing env var | `pm2 logs trading-bot --err` → preflight error message tells you which key is missing |
| Bot online but `pm2 logs` shows no activity | scheduler running, but nothing to log on success | Fine — pings are silent. Wait for a real event. |
| Telegram: "Capital.com ping failed: HTTP 401" | Session tokens expired AND re-auth failed | Check CAPITAL_API_KEY_PASSWORD in `.env`; try `pm2 restart trading-bot`. Persistent failures → Capital-side issue, open a Capital support ticket |
| Bot restarts loop (pm2 shows `restarts > max_restarts`) | Unhandled crash | `pm2 logs trading-bot --err --lines 500` and post the stacktrace |
| UFW blocks something | You tried to run a web service | Bot only needs outbound. If you add something inbound, `ufw allow <port>` |
