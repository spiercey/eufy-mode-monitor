/**
 * Periodic resync: read the station's real guard mode (param 1224) and make the Group Control record
 * (setup_guard) match, so the app / keypad displays stop showing a stale mode after a keypad change.
 *
 * Syncs all modes (Off / Home / Away). This is safe because guard_sync only ever MIRRORS the station's
 * real mode into the cloud record — it reads param 1224 and makes the record follow. It never changes
 * the station, and setup_guard only updates the cloud record (verified), so the record becomes the
 * Away group only when the keypad has already put the base in Away: the record catches up to reality
 * and no arming is ever triggered by this script.
 *
 *   node --env-file=.env guard_sync.ts                     poll forever (default 60s)
 *   node --env-file=.env guard_sync.ts once                run one cycle and exit (good for cron)
 *   GUARD_INTERVAL=30 node --env-file=.env guard_sync.ts   poll every 30s
 */
import { loginClient } from "./_client.ts";
import {
  activeGroup,
  groupForMode,
  readGroups,
  readStationMode,
  resolveContext,
  setGroup,
  type GuardContext,
} from "./guard_lib.ts";

const INTERVAL_MS = Math.max(5, Number(process.env.GUARD_INTERVAL ?? 60)) * 1000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function syncOnce(ctx: GuardContext): Promise<void> {
  const [mode, groups] = await Promise.all([readStationMode(ctx), readGroups(ctx.eufy, ctx.houseId)]);
  const active = activeGroup(groups);

  if (mode == null) {
    log("skip: could not read station guard mode (param 1224)");
    return;
  }
  const target = groupForMode(groups, ctx.stationSn, mode);
  if (!target) {
    log(`skip: station mode ${mode} has no matching group`);
    return;
  }

  if (active?.group_id === target.group_id) {
    log(`in sync: station mode ${mode}, record="${target.group_name}"`);
    return;
  }

  log(`resync: station mode ${mode} -> setup_guard "${target.group_name}" (record was "${active?.group_name ?? "none"}")`);
  await setGroup(ctx, target.group_id);

  await new Promise((r) => setTimeout(r, 8000)); // record flips only after the station confirms
  const after = activeGroup(await readGroups(ctx.eufy, ctx.houseId));
  log(after?.group_id === target.group_id ? `OK: record now "${after?.group_name}"` : `WARN: record is "${after?.group_name ?? "none"}" after write`);
}

async function main(): Promise<void> {
  const once = process.argv[2] === "once";
  let eufy = await loginClient();
  let ctx = await resolveContext(eufy);
  log(`logged in (region ${eufy.api.regionShard}) as "${ctx.userName}"; station ${ctx.stationSn}; interval=${INTERVAL_MS / 1000}s mode=${once ? "once" : "daemon"}`);

  const cycle = async (): Promise<void> => {
    try {
      await syncOnce(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`cycle error: ${msg}`);
      if (/session|login|auth|token|expire/i.test(msg)) {
        try {
          eufy = await loginClient();
          ctx = await resolveContext(eufy);
          log("re-logged in");
        } catch (e2) {
          log(`re-login failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
        }
      }
    }
  };

  await cycle();
  if (once) {
    await eufy.disconnect();
    return;
  }

  const timer = setInterval(cycle, INTERVAL_MS);
  const stop = (): void => {
    clearInterval(timer);
    log("stopping");
    eufy.disconnect().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
