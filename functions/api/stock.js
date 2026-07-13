import {
  ensureDatabase,
  json,
  normalizeDate,
  normalizeNumber,
} from "../_lib/db.js";

function parseStockEntry(entry) {
  const itemId = Number(entry?.itemId);
  const qty = normalizeNumber(
    entry?.qty,
    { allowNull: true, min: 0 }
  );

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return null;
  }

  return { itemId, qty };
}

async function saveEntries(db, date, entries) {
  const unique = new Map();

  for (const entry of entries) {
    const parsed = parseStockEntry(entry);
    if (!parsed) {
      throw new Error("Um dos itens enviados é inválido.");
    }
    unique.set(parsed.itemId, parsed);
  }

  const normalizedEntries = [...unique.values()];

  if (!normalizedEntries.length) {
    return [];
  }

  const ids = normalizedEntries.map(entry => entry.itemId);
  const placeholders = ids.map(() => "?").join(",");

  const existing = await db.prepare(`
    SELECT id
    FROM items
    WHERE active = 1
      AND id IN (${placeholders})
  `).bind(...ids).all();

  const existingIds = new Set(
    (existing.results || []).map(item => Number(item.id))
  );

  const missing = ids.filter(id => !existingIds.has(id));
  if (missing.length) {
    throw new Error("Um ou mais itens não foram encontrados.");
  }

  const statements = normalizedEntries.map(entry => {
    if (entry.qty === null) {
      return db.prepare(`
        DELETE FROM daily_stock
        WHERE stock_date = ?
          AND item_id = ?
      `).bind(date, entry.itemId);
    }

    return db.prepare(`
      INSERT INTO daily_stock (
        stock_date,
        item_id,
        current_qty,
        updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(stock_date, item_id)
      DO UPDATE SET
        current_qty = excluded.current_qty,
        updated_at = CURRENT_TIMESTAMP
    `).bind(date, entry.itemId, entry.qty);
  });

  for (let start = 0; start < statements.length; start += 40) {
    await db.batch(statements.slice(start, start + 40));
  }

  return normalizedEntries.map(entry => ({
    itemId: entry.itemId,
    currentQty: entry.qty,
  }));
}

export async function onRequestPost(context) {
  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);

    const body = await context.request.json();
    const date = normalizeDate(body.date);

    if (!date) {
      return json({ error: "Data inválida." }, 400);
    }

    // Novo formato em lote.
    if (Array.isArray(body.items)) {
      const saved = await saveEntries(db, date, body.items);

      return json({
        ok: true,
        saved,
        savedCount: saved.length,
        persistenceVersion: "stock-batch-v8",
      });
    }

    // Compatibilidade com chamadas antigas de um único item.
    const saved = await saveEntries(db, date, [{
      itemId: body.itemId,
      qty: body.qty,
    }]);

    return json({
      ok: true,
      currentQty: saved[0]?.currentQty ?? null,
      saved,
      savedCount: saved.length,
      persistenceVersion: "stock-batch-v8",
    });
  } catch (error) {
    console.error(error);

    return json(
      {
        error: String(
          error?.message || "Não foi possível salvar o estoque."
        ),
      },
      500
    );
  }
}
