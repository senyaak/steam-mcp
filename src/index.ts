#!/usr/bin/env node
/**
 * steam-mcp — an MCP server that exposes a player's Steam library and
 * achievements via the Steam Web API so Claude can help unlock them. Served over
 * Streamable HTTP so it can be exposed publicly through a cloudflare tunnel.
 *
 * Tools:
 *   resolve_steam_id           vanity name / profile URL -> SteamID64
 *   get_player_summary         profile name, status, what they're playing now
 *   get_owned_games            full library + playtime
 *   get_recently_played_games  games played in the last 2 weeks
 *   find_game                  appid by game name (cached Steam app list)
 *   get_player_achievements    per-game achievements: status + rarity + hints
 *
 * Requires env STEAM_API_KEY (https://steamcommunity.com/dev/apikey).
 * Listens on PORT (default 3846) at /mcp; health check at /health.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Load .env (Node >=20.12) from the project root, regardless of the cwd we are
// launched with. Env vars already set by the host still take priority.
try {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (!process.env.STEAM_API_KEY) process.loadEnvFile(join(projectRoot, ".env"));
} catch {
  /* no .env file — rely on the ambient environment */
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

import {
  getAppList,
  getGameSchema,
  getGlobalAchievementPercentages,
  getOwnedGames,
  getPlayerAchievements,
  getPlayerSummary,
  getRecentlyPlayedGames,
  looksLikeSteamId,
  parseVanity,
  resolveVanityUrl,
  SteamApiError,
  type AppListEntry,
} from "./steam.js";
import {
  distillGame,
  mergeAchievements,
  pct,
  type MergedAchievement,
} from "./format.js";
import { cacheStats, initDiskCache } from "./cache.js";

const PORT = Number(process.env.PORT) || 3846;

const DEFAULT_STEAM_ID = process.env.STEAM_ID?.trim() || undefined;

const PERSONA_STATE: Record<number, string> = {
  0: "offline",
  1: "online",
  2: "busy",
  3: "away",
  4: "snooze",
  5: "looking to trade",
  6: "looking to play",
};

/** Resolve which SteamID64 to use: explicit arg, else STEAM_ID env. */
function resolveSteamId(provided?: string): string {
  const id = provided?.trim() || DEFAULT_STEAM_ID;
  if (!id) {
    throw new Error(
      "No steam_id provided and STEAM_ID env is not set. Pass a SteamID64, or call resolve_steam_id with your vanity name / profile URL first.",
    );
  }
  if (!looksLikeSteamId(id)) {
    throw new Error(
      `"${id}" is not a 17-digit SteamID64. Use resolve_steam_id to convert a vanity name or profile URL.`,
    );
  }
  return id;
}

const steamIdSchema = z
  .string()
  .optional()
  .describe(
    "Target SteamID64 (17 digits). Optional — falls back to the STEAM_ID env var. Use resolve_steam_id to get one from a vanity name.",
  );

function asText(payload: unknown, pretty = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload),
      },
    ],
  };
}

function asError(err: unknown) {
  const message =
    err instanceof SteamApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

/**
 * Search the Steam app list for a game by name. Ranks exact (case-insensitive)
 * matches first, then prefix matches, then substring matches. Drops empty-name
 * junk entries. Returns up to `limit` results.
 */
function searchApps(apps: AppListEntry[], query: string, limit: number): AppListEntry[] {
  const q = query.trim().toLowerCase();
  const exact: AppListEntry[] = [];
  const prefix: AppListEntry[] = [];
  const substr: AppListEntry[] = [];
  for (const app of apps) {
    if (!app.name) continue;
    const name = app.name.toLowerCase();
    if (name === q) exact.push(app);
    else if (name.startsWith(q)) prefix.push(app);
    else if (name.includes(q)) substr.push(app);
  }
  // Within a tier, shorter names are usually the base game (not a DLC/soundtrack).
  const byLen = (a: AppListEntry, b: AppListEntry) => a.name.length - b.name.length;
  return [...exact.sort(byLen), ...prefix.sort(byLen), ...substr.sort(byLen)].slice(
    0,
    limit,
  );
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "resolve_steam_id",
    {
      title: "Resolve a SteamID64",
      description:
        "Convert a Steam vanity name, /id/<name> URL, or /profiles/<id> URL into a 17-digit " +
        "SteamID64 (and return the profile summary). Use this once to find the id, then set it " +
        "as STEAM_ID or pass it to the other tools.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Vanity name (e.g. 'gabelogannewell'), a steamcommunity.com/id/<name> URL, a " +
              "/profiles/<id> URL, or a bare SteamID64.",
          ),
      },
    },
    async ({ query }) => {
      try {
        const parsed = parseVanity(query);
        const steamId = parsed.steamId ?? (await resolveVanityUrl(parsed.vanity!));
        const summary = await getPlayerSummary(steamId);
        return asText({
          steamId,
          resolvedFrom: parsed.steamId ? "id" : parsed.vanity,
          profile: summary
            ? {
                name: summary.personaname,
                url: summary.profileurl,
                state: PERSONA_STATE[summary.personastate] ?? "unknown",
                public: summary.communityvisibilitystate === 3,
                playingNow: summary.gameextrainfo,
              }
            : null,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_player_summary",
    {
      title: "Get profile summary",
      description:
        "Get a player's public profile: persona name, online status, profile visibility, and " +
        "the game they're currently in (if any).",
      inputSchema: { steam_id: steamIdSchema },
    },
    async ({ steam_id }) => {
      try {
        const steamId = resolveSteamId(steam_id);
        const s = await getPlayerSummary(steamId);
        if (!s) return asText({ steamId, found: false });
        return asText({
          steamId,
          name: s.personaname,
          realName: s.realname,
          url: s.profileurl,
          avatar: s.avatarfull,
          state: PERSONA_STATE[s.personastate] ?? "unknown",
          public: s.communityvisibilitystate === 3,
          playingNow: s.gameextrainfo,
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_owned_games",
    {
      title: "List owned games",
      description:
        "List the games on a Steam account with playtime. Sorted by total playtime by default. " +
        "Requires the profile's game details to be Public. Use the returned appid with " +
        "get_player_achievements.",
      inputSchema: {
        steam_id: steamIdSchema,
        sort: z
          .enum(["playtime", "name", "recent"])
          .default("playtime")
          .describe("Sort order: playtime (most played first), name (A→Z), recent (last played first)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .default(50)
          .describe("Max games to return (1-2000)."),
        played_only: z
          .boolean()
          .default(false)
          .describe("Only include games with >0 playtime."),
      },
    },
    async ({ steam_id, sort, limit, played_only }) => {
      try {
        const steamId = resolveSteamId(steam_id);
        let games = (await getOwnedGames(steamId)).map(distillGame);
        if (played_only) games = games.filter((g) => g.playtimeMinutes > 0);
        const total = games.length;
        if (sort === "name") {
          games.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        } else if (sort === "recent") {
          games.sort((a, b) => (b.lastPlayed ?? "").localeCompare(a.lastPlayed ?? ""));
        } else {
          games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);
        }
        return asText({
          steamId,
          totalGames: total,
          returned: Math.min(limit, total),
          games: games.slice(0, limit),
        });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_recently_played_games",
    {
      title: "List recently played games",
      description:
        "List the games a player has played in the last 2 weeks, with recent and total playtime. " +
        "Good starting point for 'what should I grind achievements in'.",
      inputSchema: { steam_id: steamIdSchema },
    },
    async ({ steam_id }) => {
      try {
        const steamId = resolveSteamId(steam_id);
        const games = (await getRecentlyPlayedGames(steamId)).map(distillGame);
        return asText({ steamId, count: games.length, games });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "find_game",
    {
      title: "Find a game's appid by name",
      description:
        "Look up Steam appid(s) by game name using the cached Steam app list. Returns the best " +
        "matches (exact, then prefix, then substring). Use the appid with get_player_achievements " +
        "when you only know the game's name. Tip: prefer an appid from get_owned_games when possible — " +
        "it's exact.",
      inputSchema: {
        query: z.string().describe("Game name to search for, e.g. 'Hollow Knight'."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .default(8)
          .describe("Max matches to return (1-25)."),
      },
    },
    async ({ query, limit }) => {
      try {
        const apps = await getAppList();
        const matches = searchApps(apps, query, limit);
        return asText({ query, matches });
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_player_achievements",
    {
      title: "Get achievements for a game",
      description:
        "For one game (by appid), return the player's achievements merged with their definitions " +
        "and global rarity: name, description, unlocked status + date, hidden flag, and global " +
        "unlock percentage (lower % = rarer/harder). Use filter='locked' + sort='rarity' to surface " +
        "the easiest remaining achievements to grind. Get the appid from get_owned_games or find_game.",
      inputSchema: {
        appid: z.number().int().describe("Steam appid of the game."),
        steam_id: steamIdSchema,
        filter: z
          .enum(["all", "locked", "unlocked"])
          .default("all")
          .describe("Which achievements to return: all, locked (not yet earned), or unlocked."),
        sort: z
          .enum(["rarity", "name", "unlock"])
          .default("rarity")
          .describe(
            "Sort: rarity (highest global % first — easiest at top for locked ones), name (A→Z), " +
              "unlock (most recently unlocked first).",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(200)
          .describe("Max achievements to return (1-500)."),
      },
    },
    async ({ appid, steam_id, filter, sort, limit }) => {
      try {
        const steamId = resolveSteamId(steam_id);
        // Player achievements is the only call that can fail on private/empty; do
        // schema and globals best-effort alongside it.
        const [playerRes, schemaRes, globalsRes] = await Promise.allSettled([
          getPlayerAchievements(steamId, appid),
          getGameSchema(appid),
          getGlobalAchievementPercentages(appid),
        ]);

        if (playerRes.status === "rejected") throw playerRes.reason;
        const player = playerRes.value;
        const schema =
          schemaRes.status === "fulfilled" ? schemaRes.value : { gameName: undefined, achievements: [] };
        const globals =
          globalsRes.status === "fulfilled" ? globalsRes.value : new Map<string, number>();

        let merged: MergedAchievement[] = mergeAchievements(
          schema.achievements,
          player,
          globals,
        ).map((a) => ({ ...a, globalPercent: pct(a.globalPercent) }));

        const unlockedCount = merged.filter((a) => a.unlocked).length;
        const totalCount = merged.length;

        if (filter === "locked") merged = merged.filter((a) => !a.unlocked);
        else if (filter === "unlocked") merged = merged.filter((a) => a.unlocked);

        if (sort === "name") {
          merged.sort((a, b) => a.name.localeCompare(b.name));
        } else if (sort === "unlock") {
          merged.sort((a, b) => (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? ""));
        } else {
          // rarity: highest global % first (easiest), unknowns last.
          merged.sort((a, b) => (b.globalPercent ?? -1) - (a.globalPercent ?? -1));
        }

        return asText({
          steamId,
          appid,
          game: schema.gameName,
          progress: {
            unlocked: unlockedCount,
            total: totalCount,
            percent: totalCount ? Math.round((unlockedCount / totalCount) * 1000) / 10 : 0,
          },
          returned: Math.min(limit, merged.length),
          achievements: merged.slice(0, limit),
        });
      } catch (err) {
        return asError(err);
      }
    },
  );
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "steam-mcp", version: "0.1.0" },
    {
      instructions:
        "MCP server for a player's Steam library and achievements via the Steam Web API. " +
        "If you don't have a SteamID64, call resolve_steam_id with a vanity name or profile URL. " +
        "Use get_owned_games / get_recently_played_games to see what they play, find_game to turn a " +
        "name into an appid, and get_player_achievements (filter='locked', sort='rarity') to find the " +
        "easiest achievements left to unlock and advise on them. steam_id defaults to the STEAM_ID env. " +
        "Profiles and game details must be set to Public for any of this to return data. " +
        "Hidden achievements only expose a name + rarity (Steam withholds their description until the " +
        "player unlocks them) — for those, look up a guide by the achievement name + game to explain " +
        "how to get it. The server provides the data; you provide the guidance and unlock strategy.",
    },
  );
  registerTools(server);
  return server;
}

// --- HTTP transport, stateless Streamable HTTP. -----------------------------
// One fresh transport + server per request, no session id — what the claude.ai
// web connector reliably accepts. Tools keep no per-session state (the cache is
// module-level and shared), so stateless is a clean fit.

const app = express();
app.use(express.json());

app.use((req, _res, next) => {
  const ua = req.headers["user-agent"] ?? "";
  const auth = req.headers["authorization"] ? " auth" : "";
  console.error(`[req] ${req.method} ${req.originalUrl}${auth} ua="${ua}"`);
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.STEAM_API_KEY),
    defaultSteamId: DEFAULT_STEAM_ID ?? null,
    cache: cacheStats(),
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    const server = createServer();
    await server.connect(transport);
    res.on("close", () => {
      void server.close();
      void transport.close();
    });
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[error]", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "SSE not supported in stateless mode" });
});

app.delete("/mcp", (_req, res) => {
  res.status(200).json({ message: "ok" });
});

const { loaded } = initDiskCache();

app.listen(PORT, () => {
  console.error(`steam-mcp server running on http://localhost:${PORT}/mcp`);
  console.error(`Health check: http://localhost:${PORT}/health`);
  console.error(`Disk cache: ${loaded} entries preloaded`);
  if (DEFAULT_STEAM_ID) console.error(`Default SteamID: ${DEFAULT_STEAM_ID}`);
  if (!process.env.STEAM_API_KEY) {
    console.error("WARNING: STEAM_API_KEY is not set — tool calls will fail.");
  }
});
