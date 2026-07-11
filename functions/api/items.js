import { ensureDatabase, json, normalizeDate } from "../_lib/db.js";

export async function onRequestGet(context) {
  try {
    await ensureDatabase(context.env.DB);

    const url = new URL(context.request.url);
    const date = normalizeDate(url.searchParams.get("date"));

    const query = date
      ? context.env.DB.prepare(`
          SELECT
            i.id,
            i.name,
            i.category,
            i.sector,
            i.unit,
            i.minimum_qty AS minimumQty,
            i.minimum_unit AS minimumUnit,
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
              WHEN 'salao' THEN 4
              ELSE 5
            END,
            i.sort_order,
            i.name
        `).bind(date)
      : context.env.DB.prepare(`
          SELECT
            id,
            name,
            category,
            sector,
            unit,
            minimum_qty AS minimumQty,
            minimum_unit AS minimumUnit,
            sort_order AS sortOrder,
            NULL AS currentQty
          FROM items
          WHERE active = 1
          ORDER BY
            CASE sector
              WHEN 'cozinha' THEN 1
              WHEN 'pizzaria' THEN 2
              WHEN 'bar' THEN 3
              WHEN 'salao' THEN 4
              ELSE 5
            END,
            sort_order,
            name
        `);

    const result = await query.all();
    return json({ items: result.results || [] });
  } catch (error) {
    console.error(error);
    return json({ error: "Não foi possível carregar os itens." }, 500);
  }
}
