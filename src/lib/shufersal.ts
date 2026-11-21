import { gunzipSync } from "zlib";
import { XMLParser } from "fast-xml-parser";

/**
 * Shufersal price-transparency feed (public, required by Israel's Food Law).
 * Listing pages on prices.shufersal.co.il link to gzipped XML files on Azure blob
 * storage via short-lived signed URLs, so we resolve the latest file every run.
 */

const LISTING_URL = "https://prices.shufersal.co.il/FileObject/UpdateCategory";

/** Store 413 is "שופרסל ONLINE" (the online shop). Override with SHUFERSAL_STORE_ID. */
export const DEFAULT_STORE_ID = "413";

export const FileCategory = {
  PriceFull: 2,
  PromoFull: 4,
} as const;

export interface ProductRow {
  item_code: string;
  name: string;
  manufacturer: string | null;
  quantity: number | null;
  unit_qty: string | null;
  unit_of_measure: string | null;
  is_weighted: boolean;
  price: number;
  unit_price: number | null;
  price_updated_at: string | null;
}

export interface PromotionRow {
  promotion_id: number;
  item_code: string;
  description: string;
  reward_type: number | null;
  min_qty: number | null;
  discounted_price: number | null;
  promo_unit_price: number | null;
  starts_at: string | null;
  ends_at: string | null;
}

export function getStoreId(): string {
  const id = (process.env.SHUFERSAL_STORE_ID ?? "").trim();
  return /^\d+$/.test(id) ? id : DEFAULT_STORE_ID;
}

// ── Fetching ───────────────────────────────────────

/** Returns the newest file URL of a category for a store, or null if none is listed. */
export async function findLatestFileUrl(category: number, storeId: string): Promise<string | null> {
  const res = await fetch(`${LISTING_URL}?catID=${category}&storeId=${encodeURIComponent(storeId)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Listing request failed: ${res.status}`);
  return pickLatestFileUrl(await res.text());
}

export function pickLatestFileUrl(html: string): string | null {
  const urls = Array.from(
    html.matchAll(/href="(https:\/\/pricesprodpublic\.blob\.core\.windows\.net\/[^"]+)"/g),
    (m) => m[1].replace(/&amp;/g, "&")
  );
  if (urls.length === 0) return null;
  // File names end with -YYYYMMDD-HHMMSS.gz; sort newest first.
  const stamp = (u: string) => u.match(/-(\d{8}-\d{6})\.gz/)?.[1] ?? "";
  return urls.sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
}

export async function downloadXml(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  return (isGzip ? gunzipSync(buf) : buf).toString("utf-8").replace(/^﻿/, "");
}

/** File name without the signed query string, for logging. */
export function fileNameFromUrl(url: string): string {
  return url.split("?")[0].split("/").pop() ?? url;
}

// ── Parsing ────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep barcodes like "0072..." as strings
  trimValues: true,
  isArray: (name) => ["Item", "Promotion", "Group", "PromotionItem"].includes(name),
});

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The feed's timestamps are Israel local time without an offset
 * (e.g. "2026-11-28T02:59:00.000"). Convert to an ISO UTC string.
 */
export function israelTimeToIso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, se || 0);
  // Find Israel's offset at that moment (handles DST).
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(asUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = shown - asUtc;
  return new Date(asUtc - offset).toISOString();
}

export function parsePriceFull(xml: string): ProductRow[] {
  const doc = parser.parse(xml);
  const items: Record<string, unknown>[] = doc?.Root?.Items?.Item ?? [];
  const byCode = new Map<string, ProductRow>();

  for (const it of items) {
    const item_code = str(it.ItemCode);
    const name = str(it.ItemName);
    const price = num(it.ItemPrice);
    if (!item_code || !name || price === null || price <= 0) continue;

    byCode.set(item_code, {
      item_code,
      name,
      manufacturer: str(it.ManufactureName),
      quantity: num(it.Quantity),
      unit_qty: str(it.UnitQty),
      unit_of_measure: str(it.UnitOfMeasure),
      is_weighted: str(it.bIsWeighted) === "1",
      price: round2(price),
      unit_price: num(it.UnitOfMeasurePrice),
      price_updated_at: israelTimeToIso(it.PriceUpdateTime),
    });
  }

  return Array.from(byCode.values());
}

/**
 * Effective per-unit price when a deal applies, derived from the reward type:
 *  - 1 / 10: "N for X"   → DiscountedPrice is the total for MinQty units
 *  - 2 / 3:  "% off" / "fixed price" → DiscountedPrice is already per unit
 *  - other (gifts, 1+1, …) → not derivable; shown as a badge only
 */
export function effectiveUnitPrice(rewardType: number | null, minQty: number | null, discountedPrice: number | null): number | null {
  if (discountedPrice === null || discountedPrice <= 0) return null;
  if (rewardType === 1 || rewardType === 10) {
    if (!minQty || minQty <= 0) return null;
    return round2(discountedPrice / minQty);
  }
  if (rewardType === 2 || rewardType === 3) return round2(discountedPrice);
  return null;
}

/**
 * Keeps only public deals: no personal/compensation coupons, no club-only
 * promotions, and nothing that has already ended.
 */
export function parsePromoFull(xml: string, now: Date = new Date()): PromotionRow[] {
  const doc = parser.parse(xml);
  const promos: Record<string, unknown>[] = doc?.Root?.Promotions?.Promotion ?? [];
  const rows = new Map<string, PromotionRow>();

  for (const p of promos) {
    if (str(p.AdditionalIsCoupon) === "1") continue;
    if (!(str(p.ClubID) ?? "").startsWith("0")) continue;

    const promotion_id = num(p.PromotionID);
    const description = str(p.PromotionDescription);
    if (promotion_id === null || !description) continue;

    const ends_at = israelTimeToIso(p.PromotionEndDateTime);
    if (ends_at && new Date(ends_at) <= now) continue;
    const starts_at = israelTimeToIso(p.PromotionStartDateTime);

    const groups = ((p.Groups as Record<string, unknown> | undefined)?.Group ?? []) as Record<string, unknown>[];
    for (const g of groups) {
      const items = ((g.PromotionItems as Record<string, unknown> | undefined)?.PromotionItem ?? []) as Record<string, unknown>[];
      for (const it of items) {
        const item_code = str(it.ItemCode);
        if (!item_code) continue;
        const reward_type = num(it.RewardType);
        const min_qty = num(it.MinQty);
        const discounted_price = num(it.DiscountedPrice);
        rows.set(`${promotion_id}:${item_code}`, {
          promotion_id,
          item_code,
          description,
          reward_type,
          min_qty,
          discounted_price,
          promo_unit_price: effectiveUnitPrice(reward_type, min_qty, discounted_price),
          starts_at,
          ends_at,
        });
      }
    }
  }

  return Array.from(rows.values());
}

/** Drops derived deal prices that aren't actually cheaper than the regular price. */
export function sanitizePromotions(promos: PromotionRow[], products: ProductRow[]): PromotionRow[] {
  const prices = new Map(products.map((p) => [p.item_code, p.price]));
  return promos.map((pr) => {
    const regular = prices.get(pr.item_code);
    if (pr.promo_unit_price !== null && regular !== undefined && pr.promo_unit_price >= regular) {
      return { ...pr, promo_unit_price: null };
    }
    return pr;
  });
}
