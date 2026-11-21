import { getCurrentMember } from "@/lib/supabase-server";
import type { ShoppingList, ShoppingItem, MealPlanEntry, ItemCategory, LinkedProductPrice } from "@/lib/database.types";
import ShoppingListCard from "@/components/supermarket/ShoppingListCard";
import MealPlanGrid from "@/components/supermarket/MealPlanGrid";
import { addShoppingList } from "@/app/actions";

type ServerSupabase = Awaited<ReturnType<typeof getCurrentMember>>["supabase"];

/** Prices for items linked to a Shufersal product (optional data; no rows → no prices). */
async function loadLinkedPrices(supabase: ServerSupabase, codes: string[]) {
  const prices: Record<string, LinkedProductPrice> = {};
  if (codes.length === 0) return { prices, pricesAsOf: null as string | null };

  const now = Date.now();
  const [{ data: products }, { data: promos }, { data: lastRun }] = await Promise.all([
    supabase.from("shufersal_products").select("item_code, name, price, is_weighted").in("item_code", codes),
    supabase
      .from("shufersal_promotions")
      .select("item_code, description, promo_unit_price, min_qty, starts_at, ends_at")
      .in("item_code", codes),
    supabase
      .from("shufersal_sync_runs")
      .select("finished_at")
      .is("error", null)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  for (const p of products ?? []) {
    prices[p.item_code] = {
      name: p.name,
      price: Number(p.price),
      is_weighted: p.is_weighted,
      promo_description: null,
      promo_unit_price: null,
      promo_min_qty: null,
    };
  }

  // Keep the active deal with the lowest derivable unit price per product
  for (const pr of promos ?? []) {
    const target = prices[pr.item_code];
    if (!target) continue;
    if (pr.starts_at && Date.parse(pr.starts_at) > now) continue;
    if (pr.ends_at && Date.parse(pr.ends_at) <= now) continue;
    const unit = pr.promo_unit_price === null ? null : Number(pr.promo_unit_price);
    const better =
      target.promo_description === null ||
      (unit !== null && (target.promo_unit_price === null || unit < target.promo_unit_price));
    if (better) {
      target.promo_description = pr.description;
      target.promo_unit_price = unit;
      target.promo_min_qty = pr.min_qty === null ? null : Number(pr.min_qty);
    }
  }

  return { prices, pricesAsOf: (lastRun?.finished_at as string | undefined) ?? null };
}

export default async function SupermarketPage() {
  const { supabase, member } = await getCurrentMember();
  const [{ data: lists }, { data: items }, { data: meals }, { data: knownItems }, { data: allMembers }] = await Promise.all([
    supabase.from("shopping_lists").select("id, name, created_at").order("created_at", { ascending: false }),
    supabase.from("shopping_items").select("id, list_id, name, quantity, category, notes, product_code, checked").order("created_at", { ascending: true }),
    supabase.from("meal_plan").select("id, day_of_week, member_name, meal").order("created_at", { ascending: true }),
    supabase.from("item_categories").select("name, category").order("name"),
    supabase.from("family_members").select("name").order("name"),
  ]);

  const familyMembers = allMembers?.map((m) => m.name) ?? [];

  const allLists = (lists as ShoppingList[]) ?? [];
  const itemsByList = new Map<number, ShoppingItem[]>();
  for (const item of (items as ShoppingItem[]) ?? []) {
    const list = itemsByList.get(item.list_id) ?? [];
    list.push(item);
    itemsByList.set(item.list_id, list);
  }

  const codes = Array.from(new Set(((items as ShoppingItem[]) ?? []).map((i) => i.product_code).filter((c): c is string => !!c)));
  const { prices, pricesAsOf } = await loadLinkedPrices(supabase, codes);

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h1 className="text-2xl font-bold">Supermarket</h1>
        <form action={addShoppingList} className="flex gap-2">
          <input
            name="name"
            placeholder="New list name"
            required
            className="px-3 py-2 rounded-xl border-2 border-card-border bg-card text-sm focus:border-sage focus:outline-none transition-colors"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-xl bg-sage text-white text-sm font-medium hover:opacity-90 shadow-sm transition-all active:scale-95"
          >
            + List
          </button>
        </form>
      </div>

      {allLists.length === 0 ? (
        <p className="text-muted">No shopping lists yet. Create one above.</p>
      ) : (
        <div className="space-y-4">
          {allLists.map((list) => (
            <ShoppingListCard
              key={list.id}
              list={list}
              items={itemsByList.get(list.id) ?? []}
              knownItems={(knownItems as ItemCategory[]) ?? []}
              prices={prices}
              pricesAsOf={pricesAsOf}
            />
          ))}
        </div>
      )}

      <div className="mt-10 pt-8 border-t-2 border-card-border">
        <MealPlanGrid
          entries={(meals as MealPlanEntry[]) ?? []}
          memberRole={member.role}
          shoppingLists={allLists}
          members={familyMembers}
        />
      </div>
    </>
  );
}
