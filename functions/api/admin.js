import {
  cleanText,
  ensureDatabase,
  getDatabaseMarker,
  isValidSector,
  json,
  normalizeNumber,
  normalizeMoneyToCents,
  requireAdmin,
} from "../_lib/db.js";

function parseItem(body) {
  const name = cleanText(body.name, 160);
  const category = cleanText(body.category, 120);
  const sector = cleanText(body.sector, 20);
  const unit = cleanText(body.unit, 30);
  const minimumUnit = cleanText(body.minimumUnit || body.unit, 30);
  const minimumQty = normalizeNumber(body.minimumQty, { min: 0 });
  const unitCostWasFilled =
    body.unitCost !== null &&
    body.unitCost !== undefined &&
    String(body.unitCost).trim() !== "";
  const unitCostCents = normalizeMoneyToCents(
    body.unitCost,
    { allowNull: true }
  );
  const sortOrderRaw = Number(body.sortOrder ?? 0);
  const sortOrder = Number.isInteger(sortOrderRaw) ? sortOrderRaw : 0;

  if (
    !name ||
    !unit ||
    !minimumUnit ||
    minimumQty === null ||
    (unitCostWasFilled && unitCostCents === null) ||
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
    unitCostCents,
    sortOrder,
  };
}


async function readSavedItem(db, id) {
  return db.prepare(`
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
      sort_order AS sortOrder
    FROM items
    WHERE id = ?
  `).bind(id).first();
}

export async function onRequestPost(context) {
  const authError = requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);
    const dbMarker = await getDatabaseMarker(db);
    const body = await context.request.json();
    const action = cleanText(body.action, 20);

    if (action === "create") {
      const item = parseItem(body.item || {});
      if (!item) return json({ error: "Confira os campos. No custo, use por exemplo 12,50 ou 12.50." }, 400);

      const result = await db.prepare(`
        INSERT INTO items
          (
            name, category, sector, unit, minimum_qty, minimum_unit,
            unit_cost, unit_cost_cents, sort_order, active, updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).bind(
        item.name,
        item.category,
        item.sector,
        item.unit,
        item.minimumQty,
        item.minimumUnit,
        item.unitCostCents === null ? null : item.unitCostCents / 100,
        item.unitCostCents,
        item.sortOrder,
      ).run();

      const id = Number(result.meta?.last_row_id);
      const savedItem = await readSavedItem(db, id);
      return json({
        ok: true,
        id,
        item: savedItem,
        persistenceVersion: "price-persistent-v6",
        dbMarker: dbMarker.slice(0, 8)
      }, 201);
    }

    if (action === "update") {
      const id = Number(body.id);
      const item = parseItem(body.item || {});
      if (!Number.isInteger(id) || id <= 0 || !item) {
        return json({ error: "Dados inválidos. No custo, use por exemplo 12,50 ou 12.50." }, 400);
      }

      const result = await db.prepare(`
        UPDATE items SET
          name = ?,
          category = ?,
          sector = ?,
          unit = ?,
          minimum_qty = ?,
          minimum_unit = ?,
          unit_cost = ?,
          unit_cost_cents = ?,
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
        item.unitCostCents === null ? null : item.unitCostCents / 100,
        item.unitCostCents,
        item.sortOrder,
        id,
      ).run();

      if (!result.meta?.changes) return json({ error: "Item não encontrado." }, 404);
      const savedItem = await readSavedItem(db, id);
      return json({
        ok: true,
        item: savedItem,
        persistenceVersion: "price-persistent-v6",
        dbMarker: dbMarker.slice(0, 8)
      });
    }

    if (action === "delete") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) {
        return json({ error: "ID inválido." }, 400);
      }

      const result = await db
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
