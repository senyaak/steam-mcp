/**
 * Thin client for the Steam Web API (https://api.steampowered.com).
 *
 * Only the endpoints we need to read a player's library and achievements:
 *   - ISteamUser/ResolveVanityURL            vanity name -> SteamID64
 *   - ISteamUser/GetPlayerSummaries          profile (name, avatar, status)
 *   - IPlayerService/GetOwnedGames           library + playtime
 *   - IPlayerService/GetRecentlyPlayedGames  last 2 weeks
 *   - ISteamUserStats/GetSchemaForGame       achievement definitions
 *   - ISteamUserStats/GetPlayerAchievements  per-player unlock status
 *   - ISteamUserStats/GetGlobalAchievementPercentagesForApp  rarity
 *   - ISteamApps/GetAppList                  full appid <-> name map (no key)
 *
 * Most calls need the API key (STEAM_API_KEY); GetAppList and the global
 * percentages endpoint are public.
 */

import { cached, TTL } from "./cache.js";

const BASE = "https://api.steampowered.com";

export class SteamApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SteamApiError";
  }
}

function apiKey(): string {
  const key = process.env.STEAM_API_KEY?.trim();
  if (!key) {
    throw new SteamApiError(
      "STEAM_API_KEY is not set. Get one at https://steamcommunity.com/dev/apikey and put it in .env.",
    );
  }
  return key;
}

/** Language for achievement names/descriptions. */
export function lang(): string {
  return process.env.STEAM_LANG?.trim() || "english";
}

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new SteamApiError(
      `Network error calling Steam API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    // 403 almost always means a private profile or a bad key.
    const hint =
      res.status === 403
        ? " (403 — check the API key, and make sure the target profile + game details are set to Public)"
        : res.status === 401
          ? " (401 — invalid API key)"
          : "";
    throw new SteamApiError(`Steam API ${res.status} ${res.statusText}${hint}`, res.status);
  }
  return (await res.json()) as T;
}

// --- Identity ---------------------------------------------------------------

/** A SteamID64 is exactly 17 digits. */
export function looksLikeSteamId(s: string): boolean {
  return /^\d{17}$/.test(s.trim());
}

/**
 * Extract a vanity name from whatever the user pasted: a bare name, a
 * /id/<name> profile URL, or a /profiles/<id> URL (already an id).
 */
export function parseVanity(input: string): { steamId?: string; vanity?: string } {
  const s = input.trim();
  if (looksLikeSteamId(s)) return { steamId: s };
  const profiles = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profiles) return { steamId: profiles[1] };
  const idUrl = s.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (idUrl) return { vanity: decodeURIComponent(idUrl[1]) };
  return { vanity: s };
}

interface ResolveVanityResponse {
  response: { success: number; steamid?: string; message?: string };
}

/** Resolve a vanity name to a SteamID64. Throws if not found. */
export async function resolveVanityUrl(vanity: string): Promise<string> {
  return cached(`resolve:${vanity.toLowerCase()}`, TTL.resolve, async () => {
    const data = await get<ResolveVanityResponse>("ISteamUser/ResolveVanityURL/v1/", {
      key: apiKey(),
      vanityurl: vanity,
    });
    if (data.response.success !== 1 || !data.response.steamid) {
      throw new SteamApiError(
        `Could not resolve "${vanity}" to a SteamID. ${data.response.message ?? "No match — check the spelling or paste the full profile URL."}`,
      );
    }
    return data.response.steamid;
  });
}

export interface PlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatarfull: string;
  /** 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. */
  personastate: number;
  /** Present only on public profiles. */
  realname?: string;
  /** "public" derived from communityvisibilitystate === 3. */
  communityvisibilitystate: number;
  gameextrainfo?: string;
  gameid?: string;
}

interface PlayerSummariesResponse {
  response: { players: PlayerSummary[] };
}

export async function getPlayerSummary(steamId: string): Promise<PlayerSummary | null> {
  const data = await get<PlayerSummariesResponse>("ISteamUser/GetPlayerSummaries/v2/", {
    key: apiKey(),
    steamids: steamId,
  });
  return data.response.players[0] ?? null;
}

// --- Library ----------------------------------------------------------------

export interface OwnedGame {
  appid: number;
  name?: string;
  playtime_forever: number; // minutes
  playtime_2weeks?: number; // minutes
  img_icon_url?: string;
  rtime_last_played?: number; // unix seconds
  has_community_visible_stats?: boolean;
}

interface OwnedGamesResponse {
  response: { game_count?: number; games?: OwnedGame[] };
}

export async function getOwnedGames(steamId: string): Promise<OwnedGame[]> {
  return cached(`owned:${steamId}`, TTL.player, async () => {
    const data = await get<OwnedGamesResponse>("IPlayerService/GetOwnedGames/v1/", {
      key: apiKey(),
      steamid: steamId,
      include_appinfo: 1,
      include_played_free_games: 1,
    });
    if (!data.response.games) {
      throw new SteamApiError(
        "No games returned. The profile's game details are likely private — set them to Public in Steam privacy settings.",
      );
    }
    return data.response.games;
  });
}

interface RecentGamesResponse {
  response: { total_count?: number; games?: OwnedGame[] };
}

export async function getRecentlyPlayedGames(steamId: string): Promise<OwnedGame[]> {
  return cached(`recent:${steamId}`, TTL.player, async () => {
    const data = await get<RecentGamesResponse>("IPlayerService/GetRecentlyPlayedGames/v1/", {
      key: apiKey(),
      steamid: steamId,
    });
    return data.response.games ?? [];
  });
}

// --- Achievements -----------------------------------------------------------

export interface SchemaAchievement {
  name: string; // api name / internal id
  displayName: string;
  description?: string;
  hidden: number; // 1 = hidden until unlocked
  icon?: string;
  icongray?: string;
}

interface SchemaResponse {
  game?: {
    gameName?: string;
    availableGameStats?: { achievements?: SchemaAchievement[] };
  };
}

export async function getGameSchema(appid: number): Promise<{
  gameName?: string;
  achievements: SchemaAchievement[];
}> {
  return cached(`schema:${appid}:${lang()}`, TTL.schema, async () => {
    const data = await get<SchemaResponse>("ISteamUserStats/GetSchemaForGame/v2/", {
      key: apiKey(),
      appid,
      l: lang(),
    });
    return {
      gameName: data.game?.gameName,
      achievements: data.game?.availableGameStats?.achievements ?? [],
    };
  });
}

export interface PlayerAchievement {
  apiname: string;
  achieved: number; // 0 / 1
  unlocktime: number; // unix seconds
  name?: string;
  description?: string;
}

interface PlayerAchievementsResponse {
  playerstats: {
    success: boolean;
    error?: string;
    gameName?: string;
    achievements?: PlayerAchievement[];
  };
}

export async function getPlayerAchievements(
  steamId: string,
  appid: number,
): Promise<PlayerAchievement[]> {
  return cached(`ach:${steamId}:${appid}:${lang()}`, TTL.player, async () => {
    const data = await get<PlayerAchievementsResponse>(
      "ISteamUserStats/GetPlayerAchievements/v1/",
      { key: apiKey(), steamid: steamId, appid, l: lang() },
    );
    if (!data.playerstats.success) {
      throw new SteamApiError(
        data.playerstats.error ??
          "Could not read achievements. The game may have none, or the profile is private.",
      );
    }
    return data.playerstats.achievements ?? [];
  });
}

interface GlobalPercentResponse {
  achievementpercentages?: { achievements?: { name: string; percent: number }[] };
}

/** Map of achievement api-name -> global unlock percentage. Public endpoint. */
export async function getGlobalAchievementPercentages(
  appid: number,
): Promise<Map<string, number>> {
  return cached(`globals:${appid}`, TTL.globals, async () => {
    const data = await get<GlobalPercentResponse>(
      "ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/",
      { gameid: appid },
    );
    const map = new Map<string, number>();
    for (const a of data.achievementpercentages?.achievements ?? []) {
      map.set(a.name, a.percent);
    }
    return map;
  });
}

// --- App list (name <-> appid) ---------------------------------------------

export interface AppListEntry {
  appid: number;
  name: string;
}

interface StoreAppListResponse {
  response?: {
    apps?: AppListEntry[];
    have_more_results?: boolean;
    last_appid?: number;
  };
}

/**
 * The full Steam app list (games only). Steam retired the public
 * ISteamApps/GetAppList; the current source is IStoreService/GetAppList, which
 * needs the API key and is paginated. Large (tens of thousands of games), so we
 * fetch every page once and cache the merged result on disk for a day.
 */
export async function getAppList(): Promise<AppListEntry[]> {
  return cached(
    "applist",
    TTL.applist,
    async () => {
      const apps: AppListEntry[] = [];
      let lastAppid: number | undefined;
      // Hard page cap so a misbehaving API can't loop forever.
      for (let page = 0; page < 100; page++) {
        const data = await get<StoreAppListResponse>("IStoreService/GetAppList/v1/", {
          key: apiKey(),
          include_games: 1,
          include_dlc: 0,
          max_results: 50000,
          last_appid: lastAppid,
        });
        const batch = data.response?.apps ?? [];
        for (const a of batch) if (a.name) apps.push({ appid: a.appid, name: a.name });
        if (!data.response?.have_more_results || !data.response.last_appid) break;
        lastAppid = data.response.last_appid;
      }
      return apps;
    },
    true, // persist to disk — it's big and slow to fetch
  );
}
