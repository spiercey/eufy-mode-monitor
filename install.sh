#!/usr/bin/env bash
#
# eufy-mode-monitor installer.
# Prompts for your eufy credentials, writes .env + a default guard.config.json, installs deps,
# does the one-time interactive login (captcha / 2FA), and optionally installs a systemd service
# that keeps the Group Control record synced to your HomeBase mode.
#
#   ./install.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
SERVICE_NAME="eufy-mode-sync"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null 2>&1 || { warn "Node.js >= 24.5 is required (not found)."; exit 1; }
command -v npm  >/dev/null 2>&1 || { warn "npm is required (not found)."; exit 1; }
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then warn "Node.js 24.5+ recommended (found $(node -v))."; fi

# --- credentials -------------------------------------------------------------
say "eufy account"
if [ -f .env ]; then
  read -rp ".env already exists — overwrite credentials? [y/N] " ov
  [[ "${ov:-N}" =~ ^[Yy]$ ]] || SKIP_ENV=1
fi
if [ -z "${SKIP_ENV:-}" ]; then
  read -rp "  eufy email: " EMAIL
  read -rsp "  eufy password: " PASSWORD; echo
  read -rp "  country code [CA]: " COUNTRY; COUNTRY="${COUNTRY:-CA}"
  read -rp "  poll interval seconds [60]: " INTERVAL; INTERVAL="${INTERVAL:-60}"
  umask 077
  cat > .env <<EOF
EUFY_EMAIL=${EMAIL}
EUFY_PASSWORD=${PASSWORD}
EUFY_COUNTRY=${COUNTRY}
GUARD_INTERVAL=${INTERVAL}
EOF
  chmod 600 .env
  say "wrote .env (chmod 600)"
fi

# --- mapping config ----------------------------------------------------------
if [ ! -f guard.config.json ]; then
  cp guard.config.example.json guard.config.json
  say "wrote default guard.config.json (edit to remap modes; 6=Off 1=Home 0=Away)"
fi

# --- dependencies ------------------------------------------------------------
say "installing dependencies"
npm install

# --- one-time login ----------------------------------------------------------
say "establishing session (you may be prompted for a captcha and/or 2FA code)"
if node --env-file=.env guard_manual.ts read; then
  say "login OK — session saved to .eufy-session.json"
else
  warn "login step failed — fix .env and re-run: node --env-file=.env guard_manual.ts read"
fi

# --- systemd service ---------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  read -rp "install a systemd service to run the sync at boot? [Y/n] " svc
  if [[ ! "${svc:-Y}" =~ ^[Nn]$ ]]; then
    UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
    say "writing $UNIT (requires sudo)"
    sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=eufy Group Control resync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=${DIR}
ExecStart=${NODE_BIN} --env-file=.env guard_sync.ts
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now "${SERVICE_NAME}.service"
    say "service started. Logs: journalctl -u ${SERVICE_NAME} -f"
  fi
else
  warn "systemctl not found — skipping service. Run manually: node --env-file=.env guard_sync.ts"
fi

say "done."
