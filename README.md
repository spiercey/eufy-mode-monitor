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

## Setup

Requires Node.js ≥ 24.5 (runs TypeScript directly).

### Quick install (Linux, systemd)

```sh
./install.sh
```

It prompts for your eufy email/password, writes `.env` and a default `guard.config.json`, installs
dependencies, does the one-time interactive login (captcha / 2FA), and offers to install a systemd
service that runs the sync at boot (`journalctl -u eufy-mode-sync -f` to watch it).

### Manual setup

```sh
npm install
cp .env.example .env      # then fill in EUFY_EMAIL / EUFY_PASSWORD / EUFY_COUNTRY
```

First run is interactive — it prompts for a captcha and/or 2FA code and saves the session to
`.eufy-session.json` (gitignored). Later runs reuse the session and run headless.

```sh
npm run guard             # read current state (safe; verifies login/session)
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

`./install.sh` sets this up for you. To do it by hand, install a service like:

```ini
# /etc/systemd/system/eufy-mode-sync.service
[Unit]
Description=eufy Group Control resync
After=network-online.target

[Service]
WorkingDirectory=/opt/eufy-mode-monitor
ExecStart=/usr/bin/node --env-file=.env guard_sync.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

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
| `EUFY_EMAIL` / `EUFY_PASSWORD` | yes | — | account login |
| `EUFY_COUNTRY` | no | `CA` | account country code |
| `GUARD_INTERVAL` | no | `60` | poll interval (seconds) for `guard_sync` |
| `GUARD_HOUSE_ID` | no | default house | pin the house instead of auto-discovering |
| `GUARD_STATION_SN` | no | discovered | pin the guard station |
| `GUARD_USER_NAME` | no | account name | change-log label on `setup_guard` |
| `GUARD_CONFIG` | no | `./guard.config.json` | path to the mode→group mapping config |

## Files

- `install.sh` — interactive installer (credentials, config, deps, login, systemd service).
- `guard_lib.ts` — shared logic: discovery, mode↔group mapping, the `setup_guard` body, retries.
- `guard_sync.ts` — the periodic resync (daemon or `once`).
- `guard_manual.ts` — manual read/set for testing.
- `_client.ts` — login helper (captcha / 2FA), session persistence.
- `guard.config.example.json` — template for the optional mode→group mapping.

Never committed: `.env`, `.eufy-session.json`, `.eufy-captcha.png`, `guard.config.json` (all gitignored).
