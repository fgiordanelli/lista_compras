import { ensureDatabase, getDatabaseMarker, json, normalizeDate } from "../_lib/db.js";

export async function onRequestGet(context) {
  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);
    const dbMarker = await getDatabaseMarker(db);

    const url = new URL(context.request.url);
    const date = normalizeDate(url.searchParams.get("date"));

    const query = date
      ? db.prepare(`
          SELECT
            i.id,
            i.name,
            i.category,
            i.sector,
            i.unit,
            i.minimum_qty AS minimumQty,
            i.minimum_unit AS minimumUnit,
            CASE
              WHEN i.unit_cost_cents IS NULL THEN NULL
              ELSE i.unit_cost_cents / 100.0
            END AS unitCost,
            i.unit_cost_cents AS unitCostCents,
            i.sort_order AS sortOrder,
            s.current_qty AS currentQty
          FROM items i
          LEFT JOIN daily_stock s
            ON s.item_id = i.id AND s.stock_date = ?
          WHERE i.active = 1
          ORDER BY
            CASE i.sector
              WHEN 'cozinha' THEN 1
              WHEN 'pizzaria' THEN 2
              WHEN 'bar' THEN 3
              WHEN 'vinhos' THEN 4
              WHEN 'salao' THEN 5
              ELSE 6
            END,
            i.sort_order,
            i.name
        `).bind(date)
      : db.prepare(`
          SELECT
            id,
            name,
            category,
            sector,
            unit,
            minimum_qty AS minimumQty,
            minimum_unit AS minimumUnit,
            CASE
              WHEN unit_cost_cents IS NULL THEN NULL
              ELSE unit_cost_cents / 100.0
            END AS unitCost,
            unit_cost_cents AS unitCostCents,
            sort_order AS sortOrder,
            NULL AS currentQty
          FROM items
          WHERE active = 1
          ORDER BY
            CASE sector
              WHEN 'cozinha' THEN 1
              WHEN 'pizzaria' THEN 2
              WHEN 'bar' THEN 3
              WHEN 'vinhos' THEN 4
              WHEN 'salao' THEN 5
              ELSE 6
            END,
            sort_order,
            name
        `);

    const result = await query.all();
    return json({
      items: result.results || [],
      schemaVersion: "price-persistent-v5",
      dbMarker: dbMarker.slice(0, 8)
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Não foi possível carregar os itens." }, 500);
  }
}
