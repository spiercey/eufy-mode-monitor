/**
 * Shared Group Control (setup_guard) helpers.
 *
 * Everything account-specific — the house, the guard station, the mode groups, and the acting user
 * name — is discovered at runtime from the logged-in account, so this source carries no personal
 * identifiers and runs against any eufy account. Optional env overrides:
 *   GUARD_HOUSE_ID    pin the house      (default: the account's default house)
 *   GUARD_STATION_SN  pin the station    (default: the station referenced by the mode groups)
 *   GUARD_USER_NAME   change-log label   (default: the account name derived by the SDK)
 */
import { loginClient } from "./_client.ts";

export const HOST = "security-app.eufylife.com";

/** ArmingMode wire values (param 1224). Protocol constants, not account data. */
export const MODE = { away: 0, home: 1, off: 6 } as const;
/** "Away" is the alarm-arming mode; the group that targets it is gated in the manual tool. */
export const AWAY_MODE_ID = MODE.away;

export type Eufy = Awaited<ReturnType<typeof loginClient>>;
export type GuardDevice = { device_sn: string; mode_id: number; mode?: string };
export type Group = { group_id: string; group_name: string; status: number; devices?: GuardDevice[] };

/** Resolved, account-specific context — discovered once from the session, then reused. */
export type GuardContext = {
  eufy: Eufy;
  houseId: string;
  stationSn: string;
  userName: string;
};

/** Retry transient network failures (DNS blips surface as "fetch failed"); re-throw anything else. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3, delayMs = 2000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(msg)) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export async function readGroups(eufy: Eufy, houseId: string): Promise<Group[]> {
  const res = (await withRetry(() =>
    eufy.api.postSigned(HOST, "/v3/house/guard_list", { house_id: houseId }, true),
  )) as { groups?: Group[] };
  return res.groups ?? [];
}

export function activeGroup(groups: Group[]): Group | undefined {
  return groups.find((g) => g.status === 1);
}

async function discoverHouseId(eufy: Eufy): Promise<string> {
  const pinned = process.env.GUARD_HOUSE_ID?.trim();
  if (pinned) return pinned;
  const houses = (await withRetry(() => eufy.api.request("house", "/app/house/get_house_list", {}))) as {
    house_infos?: { house_id?: string; is_default?: number }[];
  };
  const infos = houses.house_infos ?? [];
  const def = infos.find((h) => h.is_default === 1) ?? infos[0];
  if (!def?.house_id) throw new Error("could not find a house on this account");
  return def.house_id;
}

/** The guard station is the device shared across the mode groups (or GUARD_STATION_SN). */
function discoverStationSn(groups: Group[]): string {
  const pinned = process.env.GUARD_STATION_SN?.trim();
  if (pinned) return pinned;
  const counts = new Map<string, number>();
  for (const g of groups) for (const d of g.devices ?? []) counts.set(d.device_sn, (counts.get(d.device_sn) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!top) throw new Error("no station found in guard_list groups");
  return top;
}

export async function resolveContext(eufy: Eufy): Promise<GuardContext> {
  const houseId = await discoverHouseId(eufy);
  const groups = await readGroups(eufy, houseId);
  const stationSn = discoverStationSn(groups);
  const userName = process.env.GUARD_USER_NAME?.trim() || (eufy.api as unknown as { accountName?: string }).accountName || "";
  return { eufy, houseId, stationSn, userName };
}

/** Read the station's real guard mode (param 1224) as a number, or undefined if unavailable. */
export async function readStationMode(ctx: GuardContext): Promise<number | undefined> {
  const devs = await withRetry(() => ctx.eufy.getDevices());
  const raw = devs.find((d) => d.sn === ctx.stationSn)?.params?.[1224];
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** The group that puts the station into `modeId` (param 1224 matched to each group's device mode_id). */
export function groupForMode(groups: Group[], stationSn: string, modeId: number): Group | undefined {
  return groups.find((g) => (g.devices ?? []).some((d) => d.device_sn === stationSn && d.mode_id === modeId));
}

/** Is this the Away / alarm-arming group (its station device targets AWAY_MODE_ID)? */
export function isAwayGroup(group: Group, stationSn: string): boolean {
  return (group.devices ?? []).some((d) => d.device_sn === stationSn && d.mode_id === AWAY_MODE_ID);
}

/** The real setup_guard body captured from the app: {house_id, group_id, user_name, enable:true}. */
export function guardBody(ctx: GuardContext, groupId: string): Record<string, unknown> {
  return { house_id: ctx.houseId, group_id: groupId, user_name: ctx.userName, enable: true };
}

/** Activate a group. On success the server returns plaintext {code:0}, which decrypts to `undefined`. */
export async function setGroup(ctx: GuardContext, groupId: string): Promise<unknown> {
  return withRetry(() => ctx.eufy.api.postSigned(HOST, "/v3/house/setup_guard", guardBody(ctx, groupId), true));
}
