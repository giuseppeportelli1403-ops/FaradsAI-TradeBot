// pm2 process manager config for the BetterOpsAI Trading Bot.
//
// Usage on the VPS (after cloning + `npm ci` + `npm run build` + creating `.env`):
//   pm2 start ecosystem.config.cjs
//   pm2 save                            # persists across reboot
//   pm2 logs trading-bot                # tail combined stdout+stderr
//   pm2 status                          # health overview
//   pm2 restart trading-bot             # after code updates
//
// The `.env` file is loaded via Node's native --env-file flag (no dotenv dep).
// `pm2 startup` (run once on first setup) installs a systemd unit so pm2
// itself comes back after a VPS reboot.

module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      cwd: __dirname,

      // Single instance. Two running bots would double-place trades.
      instances: 1,
      exec_mode: 'fork',

      // Restart policy.
      autorestart: true,
      watch: false,                    // don't hot-reload prod
      max_memory_restart: '512M',      // bot is small; restart if it leaks above this
      min_uptime: '30s',               // must stay up 30s to count as "started"
      max_restarts: 10,                // stop trying after 10 rapid restarts
      restart_delay: 4000,             // 4s between restarts
      exp_backoff_restart_delay: 100,  // exponential backoff if crash loop

      // Logs — pm2 rotates via its default log-rotate module (install with
      // `pm2 install pm2-logrotate` on the VPS first-time).
      out_file: './data/pm2-out.log',
      error_file: './data/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Graceful shutdown — gives the bot 10s to close Capital session cleanly
      // on `pm2 restart` or `pm2 stop`.
      kill_timeout: 10000,
      wait_ready: false,               // index.ts doesn't emit process.send('ready')
    },
  ],
};
