import type { LinkedProductPrice } from "@/lib/database.types";

/** Reads a leading number from free-text quantity ("2", "1.5 kg", "3 יח'"). Defaults to 1. */
export function parseQuantity(quantity: string | null | undefined): number {
  const m = (quantity ?? "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Regular cost and cost with the best deal applied, for one line. */
export function lineCost(price: LinkedProductPrice, quantity: number): { regular: number; withDeal: number } {
  const regular = price.price * quantity;
  if (price.promo_unit_price === null) return { regular, withDeal: regular };

  const minQty = price.promo_min_qty && price.promo_min_qty > 0 ? price.promo_min_qty : 1;
  if (quantity < minQty) return { regular, withDeal: regular };

  // Weighted items (min qty like 0.01 kg) get the deal on everything;
  // "N for X" deals apply to whole multiples of N, the rest at regular price.
  const dealQty = minQty < 1 ? quantity : Math.floor(quantity / minQty) * minQty;
  const withDeal = dealQty * price.promo_unit_price + (quantity - dealQty) * price.price;
  return { regular, withDeal: Math.min(regular, withDeal) };
}

export function formatShekel(n: number): string {
  return `₪${n.toFixed(2)}`;
}
