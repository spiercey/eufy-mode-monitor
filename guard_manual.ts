/**
 * Manual Group Control setter for testing: read current state, or activate a group by role/name/id.
 *
 * SAFETY: the Away group is refused unless you pass --allow-away. That gate exists because manual use
 * can write a record that doesn't match reality; setup_guard only updates the cloud record and never
 * changes the station's physical mode.
 *
 *   node --env-file=.env guard_manual.ts                        show station mode + groups + active
 *   node --env-file=.env guard_manual.ts read                   (same as above)
 *   node --env-file=.env guard_manual.ts off                    activate Off + verify
 *   node --env-file=.env guard_manual.ts staying                activate Home / "I'm Staying" + verify
 *   node --env-file=.env guard_manual.ts <group_id>             activate a raw group id + verify
 *   node --env-file=.env guard_manual.ts leaving --allow-away   activate Away (record only)
 */
import { loginClient } from "./_client.ts";
import {
  activeGroup,
  groupByModeId,
  isAwayGroup,
  MODE,
  readGroups,
  readStationMode,
  resolveContext,
  setGroup,
  type GuardContext,
  type Group,
} from "./guard_lib.ts";

/** role keyword -> station mode (param 1224). Protocol constants, not account data. */
const ROLE_MODE: Record<string, number> = {
  off: MODE.off,
  staying: MODE.home,
  home: MODE.home,
  leaving: MODE.away,
  away: MODE.away,
};

async function show(ctx: GuardContext, groups: Group[]): Promise<void> {
  const mode = await readStationMode(ctx);
  console.log(`station guard mode (param 1224): ${mode ?? "unknown"}`);
  console.log("groups:");
  for (const g of groups) {
    const away = isAwayGroup(g, ctx.stationSn) ? " (Away)" : "";
    console.log(`   ${g.group_name.padEnd(14)}${away} status=${g.status} ${g.group_id}${g.status === 1 ? " <== ACTIVE" : ""}`);
  }
}

function resolve(groups: Group[], ctx: GuardContext, token: string): Group | undefined {
  const t = token.toLowerCase();
  if (t in ROLE_MODE) return groupByModeId(groups, ctx.stationSn, ROLE_MODE[t]);
  return groups.find((g) => g.group_id === token) ?? groups.find((g) => g.group_name.toLowerCase() === t);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowAway = args.includes("--allow-away");
  const cmd = args.find((a) => !a.startsWith("--")) ?? "read";

  const eufy = await loginClient();
  const ctx = await resolveContext(eufy);
  console.log(`region: ${eufy.api.regionShard}  user: ${ctx.userName}\n`);
  const groups = await readGroups(eufy, ctx.houseId);

  if (cmd === "read" || cmd === "status" || cmd === "list") {
    await show(ctx, groups);
    await eufy.disconnect();
    return;
  }

  const target = resolve(groups, ctx, cmd);
  if (!target) {
    console.error(`unknown group "${cmd}". Use: off | staying | leaving | <group_id>, or 'read' to list.`);
    await eufy.disconnect();
    process.exit(1);
  }

  console.log("before:");
  await show(ctx, groups);

  if (isAwayGroup(target, ctx.stationSn) && !allowAway) {
    console.error(`\nREFUSED: "${target.group_name}" is the Away group. Re-run with --allow-away to set it (updates the cloud record only).`);
    await eufy.disconnect();
    process.exit(1);
  }

  console.log(`\n>>> setup_guard -> "${target.group_name}" (${target.group_id})`);
  const res = await setGroup(ctx, target.group_id);
  console.log("resp=", JSON.stringify(res));

  await new Promise((r) => setTimeout(r, 8000)); // record flips only after the station confirms
  const after = activeGroup(await readGroups(eufy, ctx.houseId));
  console.log(`\nverify: active group is now "${after?.group_name ?? "(none)"}" (${after?.group_id ?? "-"})`);
  console.log(after?.group_id === target.group_id ? "PASS ✅" : "MISMATCH ⚠️");

  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
