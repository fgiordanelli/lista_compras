import {
  cleanText,
  ensureDatabase,
  isValidSector,
  json,
  normalizeNumber,
  requireAdmin,
} from "../_lib/db.js";

function parseItem(body) {
  const name = cleanText(body.name, 160);
  const category = cleanText(body.category, 120);
  const sector = cleanText(body.sector, 20);
  const unit = cleanText(body.unit, 30);
  const minimumUnit = cleanText(body.minimumUnit || body.unit, 30);
  const minimumQty = normalizeNumber(body.minimumQty, { min: 0 });
  const sortOrderRaw = Number(body.sortOrder ?? 0);
  const sortOrder = Number.isInteger(sortOrderRaw) ? sortOrderRaw : 0;

  if (
    !name ||
    !unit ||
    !minimumUnit ||
    minimumQty === null ||
    !isValidSector(sector)
  ) {
    return null;
  }

  return {
    name,
    category,
    sector,
    unit,
    minimumUnit,
    minimumQty,
    sortOrder,
  };
}

export async function onRequestPost(context) {
  const authError = requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    await ensureDatabase(context.env.DB);
    const body = await context.request.json();
    const action = cleanText(body.action, 20);

    if (action === "create") {
      const item = parseItem(body.item || {});
      if (!item) return json({ error: "Preencha os campos obrigatórios." }, 400);

      const result = await context.env.DB.prepare(`
        INSERT INTO items
          (name, category, sector, unit, minimum_qty, minimum_unit, sort_order, active, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).bind(
        item.name,
        item.category,
        item.sector,
        item.unit,
        item.minimumQty,
        item.minimumUnit,
        item.sortOrder,
      ).run();

      return json({ ok: true, id: result.meta?.last_row_id }, 201);
    }

    if (action === "update") {
      const id = Number(body.id);
      const item = parseItem(body.item || {});
      if (!Number.isInteger(id) || id <= 0 || !item) {
        return json({ error: "Dados inválidos." }, 400);
      }

      const result = await context.env.DB.prepare(`
        UPDATE items SET
          name = ?,
          category = ?,
          sector = ?,
          unit = ?,
          minimum_qty = ?,
          minimum_unit = ?,
          sort_order = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        item.name,
        item.category,
        item.sector,
        item.unit,
        item.minimumQty,
        item.minimumUnit,
        item.sortOrder,
        id,
      ).run();

      if (!result.meta?.changes) return json({ error: "Item não encontrado." }, 404);
      return json({ ok: true });
    }

    if (action === "delete") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) {
        return json({ error: "ID inválido." }, 400);
      }

      const result = await context.env.DB
        .prepare("DELETE FROM items WHERE id = ?")
        .bind(id)
        .run();

      if (!result.meta?.changes) return json({ error: "Item não encontrado." }, 404);
      return json({ ok: true });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (error) {
    console.error(error);
    const message = String(error?.message || "");
    if (message.includes("UNIQUE")) {
      return json({ error: "Já existe um item com esse nome." }, 409);
    }
    return json({ error: "Não foi possível salvar a alteração." }, 500);
  }
}
