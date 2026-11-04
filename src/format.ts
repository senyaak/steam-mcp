/**
 * Shaping helpers: turn raw Steam payloads into compact, Claude-friendly objects
 * and merge the three achievement sources (schema + player status + global %)
 * into one list that's easy to reason about.
 */

import type {
  OwnedGame,
  PlayerAchievement,
  SchemaAchievement,
} from "./steam.js";

/** Minutes -> a short "12.3h" / "45m" string. */
export function playtime(minutes: number): string {
  if (!minutes) return "0";
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export interface DistilledGame {
  appid: number;
  name?: string;
  playtime: string;
  playtimeMinutes: number;
  playtime2weeks?: string;
  lastPlayed?: string; // ISO date, if known
  hasStats?: boolean;
}

export function distillGame(g: OwnedGame): DistilledGame {
  return {
    appid: g.appid,
    name: g.name,
    playtime: playtime(g.playtime_forever),
    playtimeMinutes: g.playtime_forever,
    playtime2weeks: g.playtime_2weeks ? playtime(g.playtime_2weeks) : undefined,
    lastPlayed: g.rtime_last_played
      ? new Date(g.rtime_last_played * 1000).toISOString().slice(0, 10)
      : undefined,
    hasStats: g.has_community_visible_stats,
  };
}

export interface MergedAchievement {
  id: string; // api name
  name: string; // display name
  description?: string;
  unlocked: boolean;
  unlockedAt?: string; // ISO datetime
  /** Global unlock rate, percent (0-100). Lower = rarer/harder. */
  globalPercent?: number;
  hidden: boolean;
}

/**
 * Merge a game's achievement schema with the player's unlock status and the
 * global rarity percentages, keyed on the achievement api-name.
 */
export function mergeAchievements(
  schema: SchemaAchievement[],
  player: PlayerAchievement[],
  globals: Map<string, number>,
): MergedAchievement[] {
  const playerById = new Map(player.map((p) => [p.apiname, p]));
  // Some games expose player achievements but an empty schema; fall back to the
  // player list so we still report something.
  const ids = schema.length
    ? schema.map((s) => s.name)
    : player.map((p) => p.apiname);

  const schemaById = new Map(schema.map((s) => [s.name, s]));

  return ids.map((id) => {
    const s = schemaById.get(id);
    const p = playerById.get(id);
    const unlocked = (p?.achieved ?? 0) === 1;
    return {
      id,
      name: s?.displayName || p?.name || id,
      description: s?.description || p?.description || undefined,
      unlocked,
      unlockedAt:
        unlocked && p?.unlocktime
          ? new Date(p.unlocktime * 1000).toISOString()
          : undefined,
      globalPercent: globals.get(id),
      hidden: (s?.hidden ?? 0) === 1,
    };
  });
}

/** Round a percent to one decimal, tolerating undefined. */
export function pct(v?: number): number | undefined {
  return v === undefined ? undefined : Math.round(v * 10) / 10;
}
