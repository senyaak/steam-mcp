/**
 * Shaping helpers: turn raw Steam payloads into compact, Claude-friendly objects
 * and merge the three achievement sources (schema + player status + global %)
 * into one list that's easy to reason about.
 */

import type {
  OwnedGame,
  PlayerAchievement,
  SchemaAchievement,
  StoreItem,
  WishlistItem,
} from "./steam.js";
import type { GgPrices } from "./ggdeals.js";

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

const STORE_TYPE: Record<number, string> = {
  0: "game",
  1: "demo",
  2: "mod",
  3: "movie",
  4: "dlc",
  5: "music",
  6: "software",
};

function isoDate(unixSeconds?: number): string | undefined {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : undefined;
}

export interface DistilledWishlistItem {
  appid: number;
  name?: string;
  type?: string;
  /** Player's ranking, 1 = top; 0 = not ranked. */
  priority: number;
  added: string; // ISO date
  /** false = delisted or not sold in this country. */
  available?: boolean;
  price?: string;
  priceCents?: number;
  originalPrice?: string;
  discountPct?: number;
  saleEnds?: string; // ISO date
  released?: string; // ISO date
  comingSoon?: string; // e.g. "Q1 2027", when not out yet
  reviews?: string; // e.g. "Very Positive (82% of 4567)"
  url: string;
  /** GG.deals prices across stores; null = unknown to GG.deals. */
  ggDeals?: DistilledGgPrices | null;
}

export function distillWishlistItem(w: WishlistItem, s?: StoreItem): DistilledWishlistItem {
  const buy = s?.best_purchase_option;
  const rv = s?.reviews?.summary_filtered;
  const cents = buy?.final_price_in_cents ? Number(buy.final_price_in_cents) : undefined;
  return {
    appid: w.appid,
    name: s?.name,
    type: s?.type !== undefined ? (STORE_TYPE[s.type] ?? String(s.type)) : undefined,
    priority: w.priority,
    added: isoDate(w.date_added) ?? "",
    available: s ? s.success === 1 : undefined,
    price: buy?.formatted_final_price ?? (s?.is_free ? "Free" : undefined),
    priceCents: cents ?? (s?.is_free ? 0 : undefined),
    originalPrice: buy?.discount_pct ? buy.formatted_original_price : undefined,
    discountPct: buy?.discount_pct || undefined,
    saleEnds: buy?.discount_pct
      ? isoDate(buy.active_discounts?.[0]?.discount_end_date)
      : undefined,
    released: s?.release?.is_coming_soon ? undefined : isoDate(s?.release?.steam_release_date),
    comingSoon: s?.release?.is_coming_soon
      ? (s.release.coming_soon_display ?? "coming soon")
      : undefined,
    reviews: rv?.review_score_label
      ? `${rv.review_score_label} (${rv.percent_positive}% of ${rv.review_count})`
      : undefined,
    url: `https://store.steampowered.com/${s?.store_url_path ?? `app/${w.appid}`}`,
  };
}

export interface DistilledGgPrices {
  /** Cheapest price right now in official stores (Steam, GOG, Humble, …). */
  retail: string | null;
  /** Cheapest price right now in keyshops (grey-market key resellers). */
  keyshops: string | null;
  lowestRetail: string | null;
  lowestKeyshops: string | null;
  /** Current retail price is at (or below) its all-time low. */
  retailAtHistoricalLow: boolean;
  url: string;
}

export function distillGg(g: GgPrices): DistilledGgPrices {
  const fmt = (v: number | null) => (v === null ? null : `${v.toFixed(2)} ${g.currency}`);
  return {
    retail: fmt(g.currentRetail),
    keyshops: fmt(g.currentKeyshops),
    lowestRetail: fmt(g.historicalRetail),
    lowestKeyshops: fmt(g.historicalKeyshops),
    retailAtHistoricalLow:
      g.currentRetail !== null &&
      g.historicalRetail !== null &&
      g.currentRetail <= g.historicalRetail,
    url: g.url,
  };
}
