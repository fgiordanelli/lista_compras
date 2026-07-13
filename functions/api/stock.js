import {
  ensureDatabase,
  json,
  normalizeDate,
  normalizeNumber,
} from "../_lib/db.js";

export async function onRequestPost(context) {
  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);
    const body = await context.request.json();

    const date = normalizeDate(body.date);
    const itemId = Number(body.itemId);
    const qty = normalizeNumber(body.qty, { allowNull: true, min: 0 });

    if (!date || !Number.isInteger(itemId) || itemId <= 0) {
      return json({ error: "Dados inválidos." }, 400);
    }

    const exists = await db
      .prepare("SELECT id FROM items WHERE id = ? AND active = 1")
      .bind(itemId)
      .first();

    if (!exists) return json({ error: "Item não encontrado." }, 404);

    if (qty === null) {
      await db
        .prepare("DELETE FROM daily_stock WHERE stock_date = ? AND item_id = ?")
        .bind(date, itemId)
        .run();
      return json({ ok: true, currentQty: null });
    }

    await db.prepare(`
      INSERT INTO daily_stock (stock_date, item_id, current_qty, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(stock_date, item_id)
      DO UPDATE SET
        current_qty = excluded.current_qty,
        updated_at = CURRENT_TIMESTAMP
    `).bind(date, itemId, qty).run();

    return json({ ok: true, currentQty: qty });
  } catch (error) {
    console.error(error);
    return json({ error: "Não foi possível salvar a quantidade." }, 500);
  }
}
