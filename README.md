# Steam MCP

An [MCP](https://modelcontextprotocol.io) server that gives Claude access to a Steam library: which
games you own, what you have been playing, which achievements you have and have not unlocked, and
how rare they are. It exists so Claude can **help you hunt achievements**: what is left, what is
easy, what is brutal, and how to get it.

The server only returns data from the Steam Web API. Advice, priorities and guides come from Claude,
which works from that data and can search the web for a specific achievement.

## Security

**The server has no authentication.** Anyone who can reach `/mcp` can call its tools using your Steam
API key, and `/health` returns your default SteamID.

It listens on all network interfaces, so keep the port firewalled. If you expose it to the internet
(a tunnel, a reverse proxy), treat the URL as a secret or put access control in front of it. Never
commit `.env`.

## Features

- **Library:** every game on the account, with playtime.
- **Recent games:** what was played in the last 2 weeks.
- **Achievements per game:** locked and unlocked, names, descriptions, unlock dates.
- **Rarity:** the global unlock percentage of each achievement.
- **Game search:** find an `appid` by name, using a cached copy of the Steam app list.
- **Profile lookup:** get a SteamID64 from a nickname, a vanity URL or a profile link.

## Requirements

1. **Node.js 20.12 or newer.**
2. **A Steam Web API key**, free from <https://steamcommunity.com/dev/apikey>. The "Domain Name" field
   is only a label, so `localhost` works. The key is permanent and tied to your account, so keep it
   secret.
3. **A SteamID64**, the 17-digit account ID. If you don't know yours, the `resolve_steam_id` tool finds
   it from a nickname or profile link.
4. **A public profile.** In Steam, set Privacy → "Game details" to *Public*. Otherwise the Web API
   returns neither the game list nor achievements.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then fill in your values
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `STEAM_API_KEY` | yes | Your Steam Web API key. |
| `STEAM_ID` | no | Default player. Without it, pass `steam_id` to each tool. |
| `STEAM_LANG` | no | Language of achievement names and descriptions. Default: `english`. |
| `PORT` | no | HTTP port. Default: `3846`. |
| `CACHE_DIR` | no | Where the app list is cached. Default: `<project>/.cache`. |

## Running

```bash
npm start     # runs dist/index.js, serving http://localhost:3846/mcp
npm run dev   # runs from source with tsx, no build step
```

Check that it is up:

```bash
curl -s localhost:3846/health
# {"status":"ok","hasApiKey":true,"defaultSteamId":"7656...","cache":{"entries":N}}
```

Environment variables are read at startup, so restart the server after editing `.env`.

## Connecting to Claude

**Claude Code:**

```bash
claude mcp add --transport http steam http://localhost:3846/mcp
```

**claude.ai:** go to Settings → Connectors → Custom connector and enter your server's public URL. This
requires exposing the server to the internet, so read [Security](#security) first. The URL **must
include the `/mcp` path**. Without it, the connector posts to `/`, gets a 404, assumes authorization
is required, and fails with *"Couldn't register…"*.

## Tools

`steam_id` is always optional and falls back to `STEAM_ID`.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `resolve_steam_id` | `query` | Nickname, `…/id/<vanity>`, `…/profiles/<id>` or a bare ID → **SteamID64** and profile. |
| `get_player_summary` | `steam_id?` | Profile: name, avatar, online status, current game. |
| `get_owned_games` | `steam_id?`, `sort` (`playtime`\|`name`\|`recent`), `limit`, `played_only` | The whole library with playtime. |
| `get_recently_played_games` | `steam_id?` | Games from the last 2 weeks, with recent and total playtime. |
| `find_game` | `query`, `limit` | `appid` by name (exact, then prefix, then substring match). |
| `get_player_achievements` | `appid`, `steam_id?`, `filter` (`all`\|`locked`\|`unlocked`), `sort` (`rarity`\|`name`\|`unlock`), `limit` | A game's achievements: name, description, status and date, `hidden`, **global %**, plus a progress summary. |

The most useful call is `get_player_achievements` with `filter=locked` and `sort=rarity`. It lists your
remaining achievements from most common (usually easiest) to rarest.

## Example prompts

- "What have I played in the last 2 weeks?"
- "Show my top 10 games by playtime."
- "Which achievements are easiest to finish in Kingdom Come: Deliverance II? Give a short guide for each."
- "How many achievements are left in Baldur's Gate 3, and which are the rarest?"
- "Find the appid for Hollow Knight and show my achievement progress."
- "Of my recent games, which one am I closest to 100% in?"

## How it works

The server speaks stateless **Streamable HTTP** MCP, built with TypeScript, the official
`@modelcontextprotocol/sdk` and Express. Each request gets a fresh transport with no session ID, which
is what the claude.ai web connector accepts most reliably. Each tool wraps one or more Steam Web API
calls and returns cleaned-up JSON.

### Mapping appids to names

- **Your own games** need no mapping: `GetOwnedGames` with `include_appinfo=true` already returns names.
- **Searching by name** uses `IStoreService/GetAppList/v1/`. Steam removed the old keyless
  `ISteamApps/GetAppList`, which now returns 404, so this needs an API key and paginated downloads. The
  list is large, so it is cached on disk for 24 hours.

### Hidden achievements

For `hidden` achievements, Steam **deliberately withholds the description** until you unlock them, both
in `GetSchemaForGame` and on the community pages. Only the name, rarity and `hidden` flag are available.
That is enough for Claude to find a guide by name. The descriptions do exist in the client's
`UserGameStatsSchema_<appid>.bin` file, but this server doesn't read it, to avoid fragile parsing with
incomplete coverage.

## Project structure

```
src/
├── index.ts    # MCP server, tool registration, Express + Streamable HTTP
├── steam.ts    # Steam Web API client
├── format.ts   # cleans up games, merges achievements (schema + status + rarity)
└── cache.ts    # TTL cache with disk persistence
```

## License

[MIT](LICENSE)
