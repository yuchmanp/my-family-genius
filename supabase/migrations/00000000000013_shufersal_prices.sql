-- ══════════════════════════════════════════════════════
-- Shufersal price data (from the public price-transparency files
-- published under Israel's Food Law, prices.shufersal.co.il).
-- Synced nightly by /api/cron/sync-prices using the service role;
-- the app only reads these tables.
-- ══════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Products — one row per item code (barcode) for the configured store
CREATE TABLE IF NOT EXISTS shufersal_products (
  item_code text PRIMARY KEY,
  name text NOT NULL,
  manufacturer text,
  quantity numeric,
  unit_qty text,
  unit_of_measure text,
  is_weighted boolean NOT NULL DEFAULT false,
  price numeric(10, 2) NOT NULL,
  unit_price numeric(10, 2),
  price_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shufersal_products_name_trgm
  ON shufersal_products USING gin (name gin_trgm_ops);

-- 2. Promotions — one row per (promotion, item). Only public, non-coupon deals.
CREATE TABLE IF NOT EXISTS shufersal_promotions (
  promotion_id bigint NOT NULL,
  item_code text NOT NULL,
  description text NOT NULL,
  reward_type smallint,
  min_qty numeric,
  discounted_price numeric(10, 2),
  -- Effective price per unit when the deal applies (null when it can't be derived)
  promo_unit_price numeric(10, 2),
  starts_at timestamptz,
  ends_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, item_code)
);

CREATE INDEX IF NOT EXISTS shufersal_promotions_item_code
  ON shufersal_promotions (item_code);

-- 3. Sync log — lets the UI show "prices as of …"
CREATE TABLE IF NOT EXISTS shufersal_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  products_count integer,
  promotions_count integer,
  source_files text[],
  error text
);

-- 4. Link shopping items to a product
ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS product_code text;

-- ── RLS: family members can read; only the service role writes ──
ALTER TABLE shufersal_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE shufersal_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shufersal_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family read" ON shufersal_products;
CREATE POLICY "Family read" ON shufersal_products
  FOR SELECT USING (auth.role() = 'authenticated' AND public.is_allowed_user());
DROP POLICY IF EXISTS "Family read" ON shufersal_promotions;
CREATE POLICY "Family read" ON shufersal_promotions
  FOR SELECT USING (auth.role() = 'authenticated' AND public.is_allowed_user());
DROP POLICY IF EXISTS "Family read" ON shufersal_sync_runs;
CREATE POLICY "Family read" ON shufersal_sync_runs
  FOR SELECT USING (auth.role() = 'authenticated' AND public.is_allowed_user());

-- ── Product search (substring + fuzzy), with the best active deal ──
CREATE OR REPLACE FUNCTION public.search_shufersal_products(q text, max_results integer DEFAULT 8)
RETURNS TABLE (
  item_code text,
  name text,
  manufacturer text,
  price numeric,
  unit_price numeric,
  unit_of_measure text,
  is_weighted boolean,
  promo_description text,
  promo_unit_price numeric,
  promo_min_qty numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT p.item_code, p.name, p.manufacturer, p.price, p.unit_price, p.unit_of_measure,
         p.is_weighted, pr.description, pr.promo_unit_price, pr.min_qty
  FROM shufersal_products p
  LEFT JOIN LATERAL (
    SELECT sp.description, sp.promo_unit_price, sp.min_qty
    FROM shufersal_promotions sp
    WHERE sp.item_code = p.item_code
      AND (sp.starts_at IS NULL OR sp.starts_at <= now())
      AND (sp.ends_at IS NULL OR sp.ends_at > now())
    ORDER BY sp.promo_unit_price ASC NULLS LAST
    LIMIT 1
  ) pr ON true
  WHERE length(trim(q)) >= 2
    AND (p.name ILIKE '%' || trim(q) || '%' OR p.name % trim(q) OR p.item_code = trim(q))
  ORDER BY
    (p.item_code = trim(q)) DESC,
    (p.name ILIKE trim(q) || '%') DESC,
    (p.name ILIKE '%' || trim(q) || '%') DESC,
    similarity(p.name, trim(q)) DESC,
    length(p.name) ASC
  LIMIT least(greatest(max_results, 1), 25);
$$;

GRANT EXECUTE ON FUNCTION public.search_shufersal_products(text, integer) TO authenticated;
