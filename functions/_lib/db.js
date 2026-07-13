import { DEFAULT_ITEMS } from "./default-items.js";

const VALID_SECTORS = new Set(["cozinha", "pizzaria", "bar", "vinhos", "salao"]);

const CATALOG_MIGRATION_ID = "catalog-organizado-v4";
const CATALOG_RENAMES = {
  "Cogumelo Paris fresco": "Cogumelo Paris",
  "Shimeji fresco": "Cogumelo shimeji",
  "Shitake fresco": "Cogumelo shiitake",
  "Manjericão fresco": "Manjericão",
  "Tomate italiano / pelado para pomodoro": "Tomate italiano",
  "Batata para gnocchi": "Batata Asterix",
  "Farinha de trigo": "Farinha para massa fresca e lasanha",
  "Farinha italiana tipo 00": "Farinha italiana tipo 00 para pizza",
  "Pão artesanal / bruschetta": "Pão artesanal para bruschetta",
  "Molho pomodoro / tomate pelado": "Molho pomodoro para pizza"
};
const OLD_DEFAULT_NAMES_TO_REMOVE = [
  "Azeite extravirgem",
  "Ervas frescas para manteiga",
  "Sal",
  "Vinhos italianos"
];


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

async function migrateLegacySectorSchema(db) {
  const schema = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'")
    .first();

  const sql = String(schema?.sql || "").toLowerCase();

  // A versão antiga tinha um CHECK que aceitava somente quatro setores.
  // A tabela nova deixa a validação no backend, facilitando novas abas no futuro.
  const needsMigration =
    sql.includes("check") &&
    sql.includes("sector") &&
    !sql.includes("'vinhos'");

  if (!needsMigration) return;

  await db.batch([
    db.prepare("DROP TABLE IF EXISTS daily_stock_v2"),
    db.prepare("DROP TABLE IF EXISTS items_v2"),

    db.prepare(`
      CREATE TABLE items_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '',
        sector TEXT NOT NULL,
        unit TEXT NOT NULL,
        minimum_qty REAL NOT NULL CHECK (minimum_qty >= 0),
        minimum_unit TEXT NOT NULL,
        unit_cost REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      INSERT INTO items_v2 (
        id, name, category, sector, unit, minimum_qty, minimum_unit,
        unit_cost, sort_order, active, created_at, updated_at
      )
      SELECT
        id, name, category, sector, unit, minimum_qty, minimum_unit,
        NULL, sort_order, active, created_at, updated_at
      FROM items
    `),

    db.prepare(`
      CREATE TABLE daily_stock_v2 (
        stock_date TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        current_qty REAL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (stock_date, item_id),
        FOREIGN KEY (item_id) REFERENCES items_v2(id) ON DELETE CASCADE
      )
    `),

    db.prepare(`
      INSERT INTO daily_stock_v2 (stock_date, item_id, current_qty, updated_at)
      SELECT stock_date, item_id, current_qty, updated_at
      FROM daily_stock
    `),

    db.prepare("DROP TABLE daily_stock"),
    db.prepare("DROP TABLE items"),
    db.prepare("ALTER TABLE items_v2 RENAME TO items"),
    db.prepare("ALTER TABLE daily_stock_v2 RENAME TO daily_stock"),

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_items_sector_sort
      ON items(sector, sort_order, name)
    `),

    // Move somente o item padrão de vinhos. Itens do bar continuam no bar.
    db.prepare(`
      UPDATE items
      SET sector = 'vinhos', updated_at = CURRENT_TIMESTAMP
      WHERE name = 'Vinhos italianos' AND sector = 'bar'
    `),
  ]);
}



async function ensureUnitCostColumn(db) {
  const columns = await db.prepare("PRAGMA table_info(items)").all();
  const hasColumn = (columns.results || []).some(
    (column) => column.name === "unit_cost"
  );

  if (!hasColumn) {
    await db.prepare("ALTER TABLE items ADD COLUMN unit_cost REAL").run();
  }
}

async function mergeOrRenameItem(db, oldName, newName) {
  if (oldName === newName) return;

  const oldItem = await db
    .prepare("SELECT id FROM items WHERE name = ?")
    .bind(oldName)
    .first();

  if (!oldItem) return;

  const newItem = await db
    .prepare("SELECT id FROM items WHERE name = ?")
    .bind(newName)
    .first();

  if (!newItem) {
    await db
      .prepare("UPDATE items SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(newName, oldItem.id)
      .run();
    return;
  }

  await db.prepare(`
    INSERT INTO daily_stock (stock_date, item_id, current_qty, updated_at)
    SELECT stock_date, ?, current_qty, updated_at
    FROM daily_stock
    WHERE item_id = ?
    ON CONFLICT(stock_date, item_id)
    DO UPDATE SET
      current_qty = COALESCE(daily_stock.current_qty, excluded.current_qty),
      updated_at = CASE
        WHEN excluded.updated_at > daily_stock.updated_at
        THEN excluded.updated_at
        ELSE daily_stock.updated_at
      END
  `).bind(newItem.id, oldItem.id).run();

  await db
    .prepare("DELETE FROM daily_stock WHERE item_id = ?")
    .bind(oldItem.id)
    .run();

  await db
    .prepare("DELETE FROM items WHERE id = ?")
    .bind(oldItem.id)
    .run();
}

async function applyCatalogOrganization(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const alreadyApplied = await db
    .prepare("SELECT id FROM app_migrations WHERE id = ?")
    .bind(CATALOG_MIGRATION_ID)
    .first();

  if (alreadyApplied) return;

  for (const [oldName, newName] of Object.entries(CATALOG_RENAMES)) {
    await mergeOrRenameItem(db, oldName, newName);
  }

  for (const oldName of OLD_DEFAULT_NAMES_TO_REMOVE) {
    await db
      .prepare("DELETE FROM items WHERE name = ?")
      .bind(oldName)
      .run();
  }

  const upserts = DEFAULT_ITEMS.map((item) =>
    db.prepare(`
      INSERT INTO items (
        name, category, sector, unit, minimum_qty,
        minimum_unit, sort_order, active, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(name)
      DO UPDATE SET
        category = excluded.category,
        sector = excluded.sector,
        unit = excluded.unit,
        minimum_qty = excluded.minimum_qty,
        minimum_unit = excluded.minimum_unit,
        sort_order = excluded.sort_order,
        active = 1,
        updated_at = CURRENT_TIMESTAMP
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

  for (let start = 0; start < upserts.length; start += 40) {
    await db.batch(upserts.slice(start, start + 40));
  }

  await db
    .prepare("INSERT INTO app_migrations (id) VALUES (?)")
    .bind(CATALOG_MIGRATION_ID)
    .run();
}

export async function ensureDatabase(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL DEFAULT '',
        sector TEXT NOT NULL,
        unit TEXT NOT NULL,
        minimum_qty REAL NOT NULL CHECK (minimum_qty >= 0),
        minimum_unit TEXT NOT NULL,
        unit_cost REAL,
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

  await migrateLegacySectorSchema(db);
  await ensureUnitCostColumn(db);
  await applyCatalogOrganization(db);

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

  for (let start = 0; start < statements.length; start += 50) {
    await db.batch(statements.slice(start, start + 50));
  }
}
