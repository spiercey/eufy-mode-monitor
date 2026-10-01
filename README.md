# eufy-mode-monitor

Keeps the eufy **Group Control** record ("Off" / "I'm Staying" / "I'm Leaving") in sync with the
HomeBase's real guard mode. When you change the mode from a physical keypad, the cloud Group Control
record can go stale, so the app and Smart Display / keypad tiles show the wrong mode. This watches the
HomeBase's actual mode and calls `setup_guard` to correct the record.

Built on [`@mega-yfue/eufy-sdk`](https://www.npmjs.com/package/@mega-yfue/eufy-sdk).

## How it works

- Reads the HomeBase's real guard mode from the cloud device params (param `1224`: `6=Off`, `1=Home`,
  `0=Away`).
- Reads the Group Control groups (`guard_list`). Each group declares the `mode_id` it puts the station
  into, so the mode→group mapping is derived at runtime — no hardcoded IDs.
- If the active group doesn't match the station's real mode, it activates the matching group with the
  request the app itself sends: `POST /v3/house/setup_guard` with `{house_id, group_id, user_name, enable:true}`.

`setup_guard` only updates the **cloud record** — it never changes the HomeBase's physical mode. The
sync only ever *mirrors* the station (it follows, never leads), so it can't arm or disarm anything;
it just makes the displayed mode match reality.

Everything account-specific (house, station, groups, user name) is discovered from the logged-in
account at runtime, so the code contains no personal identifiers.

## Authentication (no password on disk)

The eufy SDK only needs your password for the **first** sign-in: it exchanges email + password for a
session token and saves that token (not the password) to `.eufy-session.json`. Every later run loads
that token and runs without the password.

So the recommended setup keeps no password on disk:

```sh
npm run auth              # prompts for your password in memory, saves only the session token
```

Re-run `npm run auth` whenever the session expires (for example after you change your eufy password).
If you'd rather have the tool re-authenticate automatically on expiry, set `EUFY_PASSWORD` in `.env`
(that keeps the password on disk — a deliberate trade-off, off by default).

## Setup

Requires Node.js ≥ 24.5 (runs TypeScript directly). The installer runs **in place** from the cloned
directory — nothing is copied elsewhere — so keep this folder where it is after installing; the
systemd service points at it. If your system Node is older, the installer can use
[nvm](https://github.com/nvm-sh/nvm) to install/select Node 24 without changing your system Node, and
pins the service to that exact Node binary (an `.nvmrc` records the version for `nvm use`).

### Quick install (Linux, systemd)

```sh
./install.sh
```

It ensures a suitable Node (system Node if ≥24.5, otherwise via nvm), prompts for your eufy email (not
password) and writes `.env` and a default `guard.config.json`, installs dependencies, then signs you
in with `npm run auth` (password entered once, kept in memory, only the session token saved), and
offers to install a systemd service that runs the sync at boot
(`journalctl -u eufy-mode-sync -f` to watch it).

### Manual setup

```sh
npm install
cp .env.example .env      # then fill in EUFY_EMAIL / EUFY_COUNTRY (no password needed)
npm run auth              # sign in once (captcha / 2FA), saves the session
```

`npm run auth` is interactive — it prompts for a captcha and/or 2FA code and saves the session to
`.eufy-session.json` (gitignored). Later runs reuse the session and run headless.

```sh
npm run guard             # read current state (safe; verifies the saved session)
```

## Usage

Periodic resync:

```sh
npm run sync              # poll forever (default 60s)
npm run sync:once         # one cycle then exit (ideal for cron / a systemd timer)
GUARD_INTERVAL=30 npm run sync
```

Manual control (for testing):

```sh
npm run guard             # or: guard read  — show station mode + groups + active
npm run guard off         # activate Off
npm run guard staying     # activate Home / "I'm Staying"
npm run guard leaving --allow-away   # activate Away (record only; gated behind the flag)
```

### Run it permanently (systemd, Linux)

`./install.sh` sets this up for you (pinning the exact Node binary it chose). To do it by hand, install
a service like the following — set `WorkingDirectory` to your checkout and `ExecStart` to your Node's
absolute path (`command -v node`, or the nvm path like `~/.nvm/versions/node/vXX.Y.Z/bin/node`):

```ini
# /etc/systemd/system/eufy-mode-sync.service
[Unit]
Description=eufy Group Control resync
After=network-online.target

[Service]
WorkingDirectory=/path/to/eufy-mode-monitor
ExecStart=/usr/bin/node --env-file=.env guard_sync.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Updating

The app runs in place from the clone, so updating is a `git pull`. Code is TypeScript run directly (no
build step), so a pull that only changes `.ts` files just needs a service restart. If the pull changes
`package.json` (e.g. a new SDK version), run `npm install` first:

```sh
cd /path/to/eufy-mode-monitor
git pull
npm install                              # only needed when dependencies changed
sudo systemctl restart eufy-mode-sync    # if running as a service
```

Your `.env`, `.eufy-session.json`, and `guard.config.json` are gitignored, so pulls never touch them.
If a pull bumps the required Node version (`.nvmrc`), run `nvm install && nvm use` in the directory.

## Customizing the mode → group mapping

By default the mapping is discovered automatically: `guard_list` reports the `mode_id` each group puts
the station into, and that is matched to the HomeBase mode (`param 1224`). Defaults: `6→Off`,
`1→Home`, `0→Away`.

To override or limit it, create `guard.config.json` (see `guard.config.example.json`):

```json
{
  "modeToGroup": {
    "6": "Off",
    "1": "I'm Staying",
    "0": "I'm Leaving"
  }
}
```

Values are a group **name** (as shown in the app) or a group **id**. When this file is present, **only
the listed modes are synced** — remove a line to stop syncing that mode (e.g. drop `"0"` to never sync
Away). If a name/id can't be found it falls back to auto-discovery. `guard.config.json` is gitignored.

## Configuration

All via `.env` (see `.env.example`):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `EUFY_EMAIL` | yes | — | account email |
| `EUFY_PASSWORD` | no | — | optional; set only if you want automatic re-auth on token expiry (keeps the password on disk). Otherwise use `npm run auth`. |
| `EUFY_COUNTRY` | no | `CA` | account country code |
| `GUARD_INTERVAL` | no | `60` | poll interval (seconds) for `guard_sync` |
| `GUARD_HOUSE_ID` | no | default house | pin the house instead of auto-discovering |
| `GUARD_STATION_SN` | no | discovered | pin the guard station |
| `GUARD_USER_NAME` | no | account name | change-log label on `setup_guard` |
| `GUARD_CONFIG` | no | `./guard.config.json` | path to the mode→group mapping config |

## Files

- `install.sh` — interactive installer (email, config, deps, `npm run auth` login, systemd service).
- `auth.ts` — one-time interactive sign-in; password in memory only, saves the session token.
- `guard_lib.ts` — shared logic: discovery, mode↔group mapping, the `setup_guard` body, retries.
- `guard_sync.ts` — the periodic resync (daemon or `once`).
- `guard_manual.ts` — manual read/set for testing.
- `_client.ts` — login helper (session-only or interactive captcha / 2FA), session persistence.
- `guard.config.example.json` — template for the optional mode→group mapping.

Never committed: `.env`, `.eufy-session.json`, `.eufy-captcha.png`, `guard.config.json` (all gitignored).

## Disclaimer

This is an **unofficial** project and is **not affiliated with, endorsed by, or supported by Anker or
eufy**. "eufy" and "Anker" are trademarks of their respective owners, used here only to describe
interoperability.

It works against eufy's private, undocumented cloud API, which can change at any time and may break
this tool without notice. Using it may conflict with eufy's terms of service. It touches a live home
security system — review what it does before running it, and use it at your own risk.

Note that `guard_sync` only ever *mirrors* the HomeBase's real mode into the cloud Group Control
record; it never changes the HomeBase's mode and so cannot arm or disarm anything. The manual tool
(`guard_manual.ts`) can set the record directly and gates Away behind `--allow-away`.

## License

[Apache-2.0](./LICENSE) © 2026 Stephen Piercey. Contributions are accepted under the same license
(inbound = outbound).

Provided "AS IS", without warranties or conditions of any kind — see the license for the full terms.
