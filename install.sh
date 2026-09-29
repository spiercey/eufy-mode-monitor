#!/usr/bin/env bash
#
# eufy-mode-monitor installer.
# Runs IN PLACE from the cloned project directory (nothing is copied elsewhere), so keep this
# folder where it is after installing — the systemd service points at it.
#
# It ensures a suitable Node.js (>= 24.5): uses your system Node if it already qualifies, otherwise
# installs/selects Node 24 via nvm without touching your system Node. Then it prompts for your eufy
# email, writes .env + a default guard.config.json, installs deps, does a one-time interactive login
# (your password is entered here, kept only in memory, and NOT written to disk — only the resulting
# session token is saved), and optionally installs a systemd service that keeps the Group Control
# record synced to your HomeBase mode.
#
#   ./install.sh
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
SERVICE_NAME="eufy-mode-sync"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# --- node runtime ------------------------------------------------------------
# Require Node >= 24.5. Prefer system Node if it qualifies; otherwise fall back to nvm so we never
# disturb the user's system Node. NODE_BIN is resolved to an absolute path for the systemd unit.
REQUIRED_MAJOR="$( [ -f .nvmrc ] && tr -dc '0-9' < .nvmrc || echo 24 )"

# 0 if the given node binary is >= 24.5.0
node_ok() {
  "$1" -e 'const v=process.versions.node.split(".").map(Number);process.exit((v[0]>24||(v[0]===24&&v[1]>=5))?0:1)' 2>/dev/null
}

say "Node.js runtime"
NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  say "using system Node.js $("$NODE_BIN" -v)"
else
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    warn "Node.js >= 24.5 not found on this system."
    read -rp "install nvm into $NVM_DIR and use it (system Node left untouched)? [Y/n] " usenvm
    if [[ ! "${usenvm:-Y}" =~ ^[Nn]$ ]]; then
      command -v curl >/dev/null 2>&1 || { warn "curl is required to install nvm."; exit 1; }
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
  fi
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    say "installing Node.js ${REQUIRED_MAJOR} via nvm"
    nvm install "$REQUIRED_MAJOR"
    nvm use "$REQUIRED_MAJOR" >/dev/null
    set -u
    NODE_BIN="$(command -v node)"
  fi
fi

if [ -z "$NODE_BIN" ] || ! node_ok "$NODE_BIN"; then
  warn "Could not find or install Node.js >= 24.5. Install it (e.g. https://github.com/nvm-sh/nvm) and re-run."
  exit 1
fi
# Make the chosen Node/npm/npx win for the rest of this script (system Node stays the default in
# your shell; only this process and the systemd unit use the pinned binary).
export PATH="$(dirname "$NODE_BIN"):$PATH"
say "using Node.js $("$NODE_BIN" -v) at $NODE_BIN"

# --- account -----------------------------------------------------------------
say "eufy account"
if [ -f .env ]; then
  read -rp ".env already exists — overwrite settings? [y/N] " ov
  [[ "${ov:-N}" =~ ^[Yy]$ ]] || SKIP_ENV=1
fi
if [ -z "${SKIP_ENV:-}" ]; then
  read -rp "  eufy email: " EMAIL
  read -rp "  country code [CA]: " COUNTRY; COUNTRY="${COUNTRY:-CA}"
  read -rp "  poll interval seconds [60]: " INTERVAL; INTERVAL="${INTERVAL:-60}"
  umask 077
  cat > .env <<EOF
EUFY_EMAIL=${EMAIL}
EUFY_COUNTRY=${COUNTRY}
GUARD_INTERVAL=${INTERVAL}
EOF
  chmod 600 .env
  say "wrote .env (chmod 600) — note: no password is stored here"
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
say "sign in to eufy (password entered now, kept in memory only, never written to disk)"
say "you may be prompted for a captcha and/or 2FA code"
if "$NODE_BIN" --env-file=.env auth.ts; then
  say "login OK — session saved to .eufy-session.json (no password on disk)"
else
  warn "login step failed — you can retry any time with: npm run auth"
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
