import { DEFAULT_ITEMS } from "./default-items.js";

const VALID_SECTORS = new Set(["cozinha", "pizzaria", "bar", "salao"]);

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  return value;
}

export function normalizeNumber(value, { allowNull = false, min = 0 } = {}) {
  if (allowNull && (value === null || value === "" || value === undefined)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) return null;
  return parsed;
}

export function cleanText(value, maxLength = 160) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function isValidSector(value) {
  return VALID_SECTORS.has(value);
}


export function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: "ADMIN_TOKEN não configurado no Cloudflare." }, 503);
  }
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== env.ADMIN_TOKEN) {
    return json({ error: "Token administrativo inválido." }, 401);
  }
  return null;
}

export async function ensureDatabase(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '',
        sector TEXT NOT NULL CHECK (sector IN ('cozinha','pizzaria','bar','salao')),
        unit TEXT NOT NULL,
        minimum_qty REAL NOT NULL CHECK (minimum_qty >= 0),
        minimum_unit TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_stock (
        stock_date TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        current_qty REAL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (stock_date, item_id),
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_items_sector_sort
      ON items(sector, sort_order, name)
    `),
  ]);

  const countRow = await db.prepare("SELECT COUNT(*) AS total FROM items").first();
  if (Number(countRow?.total || 0) > 0) return;

  const statements = DEFAULT_ITEMS.map((item) =>
    db.prepare(`
      INSERT OR IGNORE INTO items
        (name, category, sector, unit, minimum_qty, minimum_unit, sort_order, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(
      item.name,
      item.category,
      item.sector,
      item.unit,
      item.minimumQty,
      item.minimumUnit,
      item.sortOrder,
    )
  );

  // D1 batch aceita uma lista de prepared statements.
  for (let start = 0; start < statements.length; start += 50) {
    await db.batch(statements.slice(start, start + 50));
  }
}
