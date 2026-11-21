/**
 * GG.deals prices API (https://gg.deals/api/prices/): current and historical
 * lowest prices per game, split into official retail stores and keyshops.
 *
 * Needs GG_DEALS_API_KEY. The budget is small — 100 games per minute, 1000 per
 * hour, every appid counts — so prices are cached per appid on disk for hours,
 * and a request is trimmed to what the rate limit still allows.
 */

import { peek, put, TTL } from "./cache.js";
import { country } from "./steam.js";

const BASE = "https://api.gg.deals/v1/prices/by-steam-app-id/";
/** Max ids per request, per the docs. Also the per-minute budget. */
const MAX_IDS = 100;
const REGIONS = new Set([
  "au", "be", "br", "ca", "ch", "de", "dk", "es", "eu", "fi",
  "fr", "gb", "ie", "it", "nl", "no", "pl", "se", "us",
]);

export interface GgPrices {
  title: string;
  url: string;
  currentRetail: number | null;
  currentKeyshops: number | null;
  historicalRetail: number | null;
  historicalKeyshops: number | null;
  currency: string;
}

interface GgGame {
  title: string;
  url: string;
  prices: {
    currentRetail: string | null;
    currentKeyshops: string | null;
    historicalRetail: string | null;
    historicalKeyshops: string | null;
    currency: string;
  };
}

/** On success `data` maps appid -> game (null = unknown); on error it holds `message`. */
interface GgResponse {
  success: boolean;
  data: Record<string, unknown>;
}

export function ggApiKey(): string | undefined {
  return process.env.GG_DEALS_API_KEY?.trim() || undefined;
}

/** GG.deals region from STEAM_COUNTRY; GG covers fewer countries than Steam. */
export function ggRegion(): string {
  const cc = country().toLowerCase();
  if (cc === "uk") return "gb";
  return REGIONS.has(cc) ? cc : "us";
}

/** Requests left in the current minute window, from the last response headers. */
let remaining = MAX_IDS;
let resetAt = 0; // unix ms

function budget(): number {
  if (Date.now() >= resetAt) remaining = MAX_IDS;
  return remaining;
}

const num = (s: string | null) => (s === null ? null : Number(s));

export interface GgResult {
  /** appid -> prices; null = GG.deals doesn't know the game. */
  prices: Map<number, GgPrices | null>;
  /** appids not fetched because the rate limit ran out (retry in a minute). */
  skipped: number[];
}

/**
 * Prices for the given appids: cached ones first, the rest fetched in one call
 * as far as the rate limit allows (at most 100 per minute).
 */
export async function getGgPrices(appids: number[]): Promise<GgResult> {
  const key = ggApiKey();
  if (!key) throw new Error("GG_DEALS_API_KEY is not set.");
  const region = ggRegion();
  const prices = new Map<number, GgPrices | null>();
  const missing: number[] = [];

  for (const id of new Set(appids)) {
    const hit = await peek<GgPrices | null>(`gg:${region}:${id}`);
    if (hit !== undefined) prices.set(id, hit);
    else missing.push(id);
  }

  const toFetch = missing.slice(0, Math.min(MAX_IDS, budget()));
  const skipped = missing.slice(toFetch.length);
  if (!toFetch.length) return { prices, skipped };

  const url = new URL(BASE);
  url.searchParams.set("ids", toFetch.join(","));
  url.searchParams.set("region", region);
  url.searchParams.set("key", key);
  const res = await fetch(url, { headers: { accept: "application/json" } });

  const left = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(left)) remaining = left;
  if (Number.isFinite(reset) && reset > 0) resetAt = reset * 1000;

  if (res.status === 429) {
    remaining = 0;
    return { prices, skipped: missing };
  }
  const body = (await res.json().catch(() => null)) as GgResponse | null;
  if (!res.ok || !body?.success) {
    const msg = body?.data?.message;
    throw new Error(`GG.deals API ${res.status}${typeof msg === "string" ? `: ${msg}` : ""}`);
  }

  for (const id of toFetch) {
    const g = body.data[String(id)] as GgGame | null | undefined;
    const value: GgPrices | null = g
      ? {
          title: g.title,
          url: g.url,
          currentRetail: num(g.prices.currentRetail),
          currentKeyshops: num(g.prices.currentKeyshops),
          historicalRetail: num(g.prices.historicalRetail),
          historicalKeyshops: num(g.prices.historicalKeyshops),
          currency: g.prices.currency,
        }
      : null;
    prices.set(id, value);
    put(`gg:${region}:${id}`, TTL.ggdeals, value, true);
  }
  return { prices, skipped };
}
