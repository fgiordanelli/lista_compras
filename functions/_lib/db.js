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

  let normalized = value;

  if (typeof value === "string") {
    normalized = value
      .trim()
      .replace(/\s/g, "")
      .replace(/^R\$/i, "");

    if (normalized.includes(",") && normalized.includes(".")) {
      // 1.234,56 -> 1234.56
      if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else {
        // 1,234.56 -> 1234.56
        normalized = normalized.replace(/,/g, "");
      }
    } else if (normalized.includes(",")) {
      // 12,50 -> 12.50
      normalized = normalized.replace(",", ".");
    }
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min) return null;
  return parsed;
}


export function normalizeMoneyToCents(value, { allowNull = true } = {}) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return allowNull ? null : 0;
  }

  let raw = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/^R\$/i, "");

  let normalized;

  if (raw.includes(",") && raw.includes(".")) {
    normalized =
      raw.lastIndexOf(",") > raw.lastIndexOf(".")
        ? raw.replace(/\./g, "").replace(",", ".")
        : raw.replace(/,/g, "");
  } else if (raw.includes(",")) {
    normalized = raw.replace(",", ".");
  } else {
    normalized = raw;
  }

  const amount = Number(normalized);

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return Math.round((amount + Number.EPSILON) * 100);
}

export function cleanText(value, maxLength = 160) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function isValidSector(value) {
  return VALID_SECTORS.has(value);
}



export async function getDatabaseMarker(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      marker TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  let row = await db
    .prepare("SELECT marker FROM app_identity WHERE id = 1")
    .first();

  if (!row) {
    const marker = crypto.randomUUID();
    await db
      .prepare("INSERT OR IGNORE INTO app_identity (id, marker) VALUES (1, ?)")
      .bind(marker)
      .run();

    row = await db
      .prepare("SELECT marker FROM app_identity WHERE id = 1")
      .first();
  }

  return String(row?.marker || "desconhecido");
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

  const sql = String(schema?.sql || "");

  // Migra somente o schema realmente antigo, no qual o CHECK estava
  // diretamente na coluna sector e não permitia o setor "vinhos".
  //
  // A verificação anterior procurava qualquer CHECK na tabela. Como existem
  // CHECKs em minimum_qty e active, ela acabava recriando a tabela em toda
  // requisição e zerando os custos.
  const hasLegacySectorCheck =
    /sector\s+text[^,]*check\s*\(\s*sector\s+in\s*\(/i.test(sql);

  const alreadyAcceptsWines =
    /['"]vinhos['"]/i.test(sql);

  if (!hasLegacySectorCheck || alreadyAcceptsWines) return;

  const columns = await db.prepare("PRAGMA table_info(items)").all();
  const columnNames = new Set(
    (columns.results || []).map(column => String(column.name))
  );

  // Preserva custos caso a migração seja executada sobre uma versão que já
  // possua essas colunas. Em schemas mais antigos, usa NULL.
  const unitCostExpression = columnNames.has("unit_cost")
    ? "unit_cost"
    : "NULL";

  const unitCostCentsExpression = columnNames.has("unit_cost_cents")
    ? "unit_cost_cents"
    : (
        columnNames.has("unit_cost")
          ? "CAST(ROUND(unit_cost * 100) AS INTEGER)"
          : "NULL"
      );

  const cmvEnabledExpression = columnNames.has("cmv_enabled")
    ? "cmv_enabled"
    : "1";

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
        unit_cost_cents INTEGER,
        cmv_enabled INTEGER NOT NULL DEFAULT 1 CHECK (cmv_enabled IN (0,1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      INSERT INTO items_v2 (
        id, name, category, sector, unit, minimum_qty, minimum_unit,
        unit_cost, unit_cost_cents, cmv_enabled,
        sort_order, active, created_at, updated_at
      )
      SELECT
        id, name, category, sector, unit, minimum_qty, minimum_unit,
        ${unitCostExpression},
        ${unitCostCentsExpression},
        ${cmvEnabledExpression},
        sort_order, active, created_at, updated_at
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

    db.prepare(`
      UPDATE items
      SET sector = 'vinhos', updated_at = CURRENT_TIMESTAMP
      WHERE name = 'Vinhos italianos' AND sector = 'bar'
    `),
  ]);
}



async function ensureUnitCostColumns(db) {
  const columns = await db.prepare("PRAGMA table_info(items)").all();
  const names = new Set((columns.results || []).map(column => column.name));

  if (!names.has("unit_cost")) {
    await db.prepare("ALTER TABLE items ADD COLUMN unit_cost REAL").run();
  }

  if (!names.has("unit_cost_cents")) {
    await db.prepare(
      "ALTER TABLE items ADD COLUMN unit_cost_cents INTEGER"
    ).run();
  }

  // Preserva eventuais custos gravados pela versão anterior.
  await db.prepare(`
    UPDATE items
    SET unit_cost_cents = CAST(ROUND(unit_cost * 100) AS INTEGER)
    WHERE unit_cost_cents IS NULL
      AND unit_cost IS NOT NULL
  `).run();
}


async function ensureCmvSchema(db) {
  const itemColumns = await db.prepare("PRAGMA table_info(items)").all();
  const itemColumnNames = new Set(
    (itemColumns.results || []).map(column => String(column.name))
  );

  if (!itemColumnNames.has("cmv_enabled")) {
    await db.prepare(`
      ALTER TABLE items
      ADD COLUMN cmv_enabled INTEGER NOT NULL DEFAULT 1
    `).run();
  }

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_date TEXT NOT NULL,
        snapshot_type TEXT NOT NULL
          CHECK (snapshot_type IN ('opening','closing')),
        recorded_by TEXT NOT NULL DEFAULT '',
        total_cents INTEGER NOT NULL DEFAULT 0,
        eligible_items INTEGER NOT NULL DEFAULT 0,
        counted_items INTEGER NOT NULL DEFAULT 0,
        missing_cost_items INTEGER NOT NULL DEFAULT 0,
        source_method TEXT NOT NULL DEFAULT 'manual',
        source_snapshot_id INTEGER,
        source_snapshot_date TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(snapshot_date, snapshot_type)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS inventory_snapshot_items (
        snapshot_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        item_name TEXT NOT NULL,
        sector TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        qty REAL NOT NULL,
        unit TEXT NOT NULL,
        unit_cost_cents INTEGER,
        value_cents INTEGER,
        PRIMARY KEY(snapshot_id, item_id),
        FOREIGN KEY(snapshot_id)
          REFERENCES inventory_snapshots(id)
          ON DELETE CASCADE
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_date TEXT NOT NULL,
        purchase_type TEXT NOT NULL
          CHECK (purchase_type IN ('market','supplier')),
        vendor TEXT NOT NULL DEFAULT '',
        purchase_sector TEXT NOT NULL DEFAULT '',
        purchase_category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        invoice_number TEXT NOT NULL DEFAULT '',
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        payment_method TEXT NOT NULL DEFAULT 'pix'
          CHECK (
            payment_method IN (
              'pix','dinheiro','cartao','boleto','transferencia','outro'
            )
          ),
        due_date TEXT,
        paid INTEGER NOT NULL DEFAULT 1 CHECK (paid IN (0,1)),
        include_in_cmv INTEGER NOT NULL DEFAULT 1
          CHECK (include_in_cmv IN (0,1)),
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_revenue (
        revenue_date TEXT PRIMARY KEY,
        revenue_cents INTEGER NOT NULL DEFAULT 0
          CHECK (revenue_cents >= 0),
        notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_date
      ON inventory_snapshots(snapshot_date, snapshot_type)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_purchases_date
      ON daily_purchases(purchase_date, purchase_type)
    `),
  ]);

  const purchaseColumns = await db
    .prepare("PRAGMA table_info(daily_purchases)")
    .all();

  const purchaseColumnNames = new Set(
    (purchaseColumns.results || []).map(
      column => String(column.name)
    )
  );

  if (!purchaseColumnNames.has("purchase_sector")) {
    await db.prepare(`
      ALTER TABLE daily_purchases
      ADD COLUMN purchase_sector TEXT NOT NULL DEFAULT ''
    `).run();
  }

  if (!purchaseColumnNames.has("purchase_category")) {
    await db.prepare(`
      ALTER TABLE daily_purchases
      ADD COLUMN purchase_category TEXT NOT NULL DEFAULT ''
    `).run();
  }

  const snapshotColumns = await db
    .prepare("PRAGMA table_info(inventory_snapshots)")
    .all();

  const snapshotColumnNames = new Set(
    (snapshotColumns.results || []).map(
      column => String(column.name)
    )
  );

  if (!snapshotColumnNames.has("source_method")) {
    await db.prepare(`
      ALTER TABLE inventory_snapshots
      ADD COLUMN source_method TEXT NOT NULL DEFAULT 'manual'
    `).run();
  }

  if (!snapshotColumnNames.has("source_snapshot_id")) {
    await db.prepare(`
      ALTER TABLE inventory_snapshots
      ADD COLUMN source_snapshot_id INTEGER
    `).run();
  }

  if (!snapshotColumnNames.has("source_snapshot_date")) {
    await db.prepare(`
      ALTER TABLE inventory_snapshots
      ADD COLUMN source_snapshot_date TEXT
    `).run();
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const migrationId = "cmv-enabled-defaults-v1";
  const applied = await db
    .prepare("SELECT id FROM app_migrations WHERE id = ?")
    .bind(migrationId)
    .first();

  if (!applied) {
    // Materiais operacionais ficam fora do CMV por padrão.
    await db.prepare(`
      UPDATE items
      SET cmv_enabled = CASE
        WHEN sector = 'salao' THEN 0
        WHEN lower(category) IN (
          'embalagens e operação',
          'embalagens',
          'materiais de salão',
          'limpeza'
        ) THEN 0
        ELSE 1
      END
    `).run();

    await db
      .prepare("INSERT INTO app_migrations (id) VALUES (?)")
      .bind(migrationId)
      .run();
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
        unit_cost_cents INTEGER,
        cmv_enabled INTEGER NOT NULL DEFAULT 1 CHECK (cmv_enabled IN (0,1)),
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
  await ensureUnitCostColumns(db);
  await applyCatalogOrganization(db);
  await ensureCmvSchema(db);

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
