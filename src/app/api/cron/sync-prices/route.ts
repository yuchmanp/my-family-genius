import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { getServiceClient } from "@/lib/notify-parents";
import {
  FileCategory,
  downloadXml,
  fileNameFromUrl,
  findLatestFileUrl,
  getStoreId,
  parsePriceFull,
  parsePromoFull,
  sanitizePromotions,
} from "@/lib/shufersal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH = 1000;

async function upsertInBatches(
  supabase: ReturnType<typeof getServiceClient>,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  }
}

export async function GET(request: Request) {
  const authError = verifyCronSecret(request);
  if (authError) return authError;

  const supabase = getServiceClient();
  const storeId = getStoreId();
  const syncedAt = new Date().toISOString();

  const { data: run } = await supabase
    .from("shufersal_sync_runs")
    .insert({ store_id: storeId, started_at: syncedAt })
    .select("id")
    .single();

  const finishRun = async (fields: Record<string, unknown>) => {
    if (!run) return;
    await supabase
      .from("shufersal_sync_runs")
      .update({ finished_at: new Date().toISOString(), ...fields })
      .eq("id", run.id);
  };

  try {
    const [priceUrl, promoUrl] = await Promise.all([
      findLatestFileUrl(FileCategory.PriceFull, storeId),
      findLatestFileUrl(FileCategory.PromoFull, storeId),
    ]);
    if (!priceUrl) throw new Error(`No PriceFull file listed for store ${storeId}`);

    const [priceXml, promoXml] = await Promise.all([
      downloadXml(priceUrl),
      promoUrl ? downloadXml(promoUrl) : Promise.resolve(null),
    ]);

    const products = parsePriceFull(priceXml);
    // Guard against a truncated or empty file wiping the catalog.
    if (products.length < 100) throw new Error(`Only ${products.length} products parsed; aborting`);

    const promotions = promoXml ? sanitizePromotions(parsePromoFull(promoXml), products) : [];

    await upsertInBatches(
      supabase,
      "shufersal_products",
      products.map((p) => ({ ...p, synced_at: syncedAt })),
      "item_code"
    );
    await upsertInBatches(
      supabase,
      "shufersal_promotions",
      promotions.map((p) => ({ ...p, synced_at: syncedAt })),
      "promotion_id,item_code"
    );

    // Remove rows that weren't in this run's files.
    const { error: delProductsError } = await supabase
      .from("shufersal_products")
      .delete()
      .lt("synced_at", syncedAt);
    if (delProductsError) throw new Error(`Cleanup failed: ${delProductsError.message}`);

    if (promoXml) {
      const { error: delPromosError } = await supabase
        .from("shufersal_promotions")
        .delete()
        .lt("synced_at", syncedAt);
      if (delPromosError) throw new Error(`Cleanup failed: ${delPromosError.message}`);
    }

    const sourceFiles = [priceUrl, promoUrl].filter((u): u is string => !!u).map(fileNameFromUrl);
    await finishRun({
      products_count: products.length,
      promotions_count: promotions.length,
      source_files: sourceFiles,
    });

    return NextResponse.json({
      message: "Done",
      storeId,
      products: products.length,
      promotions: promotions.length,
      files: sourceFiles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun({ error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
