import {
  cleanText,
  ensureDatabase,
  getDatabaseMarker,
  json,
  normalizeDate,
  normalizeMoneyToCents,
  requireAdmin,
} from "../_lib/db.js";

const PURCHASE_TYPES = new Set(["market", "supplier"]);
const PAYMENT_METHODS = new Set([
  "pix",
  "dinheiro",
  "cartao",
  "boleto",
  "transferencia",
  "outro",
]);
const SNAPSHOT_TYPES = new Set(["closing"]);

function boolToInt(value, defaultValue = 1) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return (
    value === false ||
    value === 0 ||
    value === "0" ||
    value === "false"
  ) ? 0 : 1;
}

function optionalDate(value) {
  if (value === null || value === undefined || value === "") return null;
  return normalizeDate(value);
}

function parsePurchase(input) {
  const purchaseDate = normalizeDate(input.purchaseDate);
  const purchaseType = cleanText(input.purchaseType, 20);
  const vendor = cleanText(input.vendor, 160);
  const purchaseSector = cleanText(input.purchaseSector, 40);
  const purchaseCategory = cleanText(input.purchaseCategory, 120);
  const description = cleanText(input.description, 240);
  const invoiceNumber = cleanText(input.invoiceNumber, 80);
  const amountCents = normalizeMoneyToCents(
    input.amount,
    { allowNull: false }
  );
  const paymentMethod = cleanText(input.paymentMethod || "pix", 30);
  const dueDate = optionalDate(input.dueDate);
  const paid = boolToInt(input.paid, paymentMethod === "boleto" ? 0 : 1);
  const includeInCmv = boolToInt(input.includeInCmv, 1);
  const notes = cleanText(input.notes, 500);

  if (
    !purchaseDate ||
    !PURCHASE_TYPES.has(purchaseType) ||
    !description ||
    amountCents === null ||
    !PAYMENT_METHODS.has(paymentMethod) ||
    (input.dueDate && !dueDate)
  ) {
    return null;
  }

  return {
    purchaseDate,
    purchaseType,
    vendor,
    purchaseSector,
    purchaseCategory,
    description,
    invoiceNumber,
    amountCents,
    paymentMethod,
    dueDate,
    paid,
    includeInCmv,
    notes,
  };
}

async function readPurchase(db, id) {
  return db.prepare(`
    SELECT
      id,
      purchase_date AS purchaseDate,
      purchase_type AS purchaseType,
      vendor,
      purchase_sector AS purchaseSector,
      purchase_category AS purchaseCategory,
      description,
      invoice_number AS invoiceNumber,
      amount_cents AS amountCents,
      amount_cents / 100.0 AS amount,
      payment_method AS paymentMethod,
      due_date AS dueDate,
      paid,
      include_in_cmv AS includeInCmv,
      notes,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM daily_purchases
    WHERE id = ?
  `).bind(id).first();
}

async function captureSnapshot(db, date, type, recordedBy) {
  const stock = await db.prepare(`
    SELECT
      i.id AS itemId,
      i.name AS itemName,
      i.sector,
      i.category,
      i.unit,
      i.unit_cost_cents AS unitCostCents,
      s.current_qty AS qty
    FROM items i
    LEFT JOIN daily_stock s
      ON s.item_id = i.id
      AND s.stock_date = ?
    WHERE i.active = 1
      AND i.cmv_enabled = 1
    ORDER BY i.sector, i.sort_order, i.name
  `).bind(date).all();

  const eligibleItems = stock.results || [];
  const countedItems = eligibleItems.filter(
    item => item.qty !== null && item.qty !== undefined
  );

  if (!countedItems.length) {
    throw new Error(
      "Nenhum estoque foi preenchido para essa data."
    );
  }

  const missingCostItems = countedItems.filter(
    item => item.unitCostCents === null || item.unitCostCents === undefined
  ).length;

  const totalCents = countedItems.reduce((sum, item) => {
    if (item.unitCostCents === null || item.unitCostCents === undefined) {
      return sum;
    }

    return sum + Math.round(
      Number(item.qty) * Number(item.unitCostCents)
    );
  }, 0);

  await db.prepare(`
    INSERT INTO inventory_snapshots (
      snapshot_date,
      snapshot_type,
      recorded_by,
      total_cents,
      eligible_items,
      counted_items,
      missing_cost_items,
      source_method,
      source_snapshot_id,
      source_snapshot_date,
      updated_at
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      'manual', NULL, NULL,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(snapshot_date, snapshot_type)
    DO UPDATE SET
      recorded_by = excluded.recorded_by,
      total_cents = excluded.total_cents,
      eligible_items = excluded.eligible_items,
      counted_items = excluded.counted_items,
      missing_cost_items = excluded.missing_cost_items,
      source_method = 'manual',
      source_snapshot_id = NULL,
      source_snapshot_date = NULL,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    date,
    type,
    recordedBy,
    totalCents,
    eligibleItems.length,
    countedItems.length,
    missingCostItems,
  ).run();

  const snapshot = await db.prepare(`
    SELECT id
    FROM inventory_snapshots
    WHERE snapshot_date = ? AND snapshot_type = ?
  `).bind(date, type).first();

  const snapshotId = Number(snapshot?.id);
  if (!snapshotId) {
    throw new Error("Não foi possível criar o fechamento de estoque.");
  }

  await db
    .prepare("DELETE FROM inventory_snapshot_items WHERE snapshot_id = ?")
    .bind(snapshotId)
    .run();

  const statements = countedItems.map(item => {
    const valueCents =
      item.unitCostCents === null || item.unitCostCents === undefined
        ? null
        : Math.round(Number(item.qty) * Number(item.unitCostCents));

    return db.prepare(`
      INSERT INTO inventory_snapshot_items (
        snapshot_id,
        item_id,
        item_name,
        sector,
        category,
        qty,
        unit,
        unit_cost_cents,
        value_cents
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      item.itemId,
      item.itemName,
      item.sector,
      item.category || "",
      item.qty,
      item.unit,
      item.unitCostCents,
      valueCents,
    );
  });

  for (let start = 0; start < statements.length; start += 40) {
    await db.batch(statements.slice(start, start + 40));
  }

  return {
    id: snapshotId,
    snapshotDate: date,
    snapshotType: type,
    recordedBy,
    totalCents,
    eligibleItems: eligibleItems.length,
    countedItems: countedItems.length,
    missingCostItems,
  };
}


async function copyPreviousClosingToOpening(
  db,
  date,
  recordedBy
) {
  const previousClosing = await db.prepare(`
    SELECT
      id,
      snapshot_date AS snapshotDate,
      total_cents AS totalCents,
      eligible_items AS eligibleItems,
      counted_items AS countedItems,
      missing_cost_items AS missingCostItems
    FROM inventory_snapshots
    WHERE snapshot_type = 'closing'
      AND snapshot_date < ?
    ORDER BY snapshot_date DESC
    LIMIT 1
  `).bind(date).first();

  if (!previousClosing) {
    throw new Error(
      "Não existe fechamento anterior. Faça uma contagem manual de abertura."
    );
  }

  const sourceItems = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM inventory_snapshot_items
    WHERE snapshot_id = ?
  `).bind(previousClosing.id).first();

  if (!Number(sourceItems?.total || 0)) {
    throw new Error(
      "O fechamento anterior não possui itens para copiar."
    );
  }

  const responsible = recordedBy || "Abertura automática";

  await db.prepare(`
    INSERT INTO inventory_snapshots (
      snapshot_date,
      snapshot_type,
      recorded_by,
      total_cents,
      eligible_items,
      counted_items,
      missing_cost_items,
      source_method,
      source_snapshot_id,
      source_snapshot_date,
      updated_at
    )
    VALUES (
      ?, 'opening', ?, ?, ?, ?, ?,
      'previous_closing', ?, ?,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT(snapshot_date, snapshot_type)
    DO UPDATE SET
      recorded_by = excluded.recorded_by,
      total_cents = excluded.total_cents,
      eligible_items = excluded.eligible_items,
      counted_items = excluded.counted_items,
      missing_cost_items = excluded.missing_cost_items,
      source_method = excluded.source_method,
      source_snapshot_id = excluded.source_snapshot_id,
      source_snapshot_date = excluded.source_snapshot_date,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    date,
    responsible,
    previousClosing.totalCents,
    previousClosing.eligibleItems,
    previousClosing.countedItems,
    previousClosing.missingCostItems,
    previousClosing.id,
    previousClosing.snapshotDate,
  ).run();

  const opening = await db.prepare(`
    SELECT id
    FROM inventory_snapshots
    WHERE snapshot_date = ?
      AND snapshot_type = 'opening'
  `).bind(date).first();

  const openingId = Number(opening?.id);

  if (!openingId) {
    throw new Error(
      "Não foi possível criar a abertura a partir do fechamento anterior."
    );
  }

  await db
    .prepare(`
      DELETE FROM inventory_snapshot_items
      WHERE snapshot_id = ?
    `)
    .bind(openingId)
    .run();

  await db.prepare(`
    INSERT INTO inventory_snapshot_items (
      snapshot_id,
      item_id,
      item_name,
      sector,
      category,
      qty,
      unit,
      unit_cost_cents,
      value_cents
    )
    SELECT
      ?,
      item_id,
      item_name,
      sector,
      category,
      qty,
      unit,
      unit_cost_cents,
      value_cents
    FROM inventory_snapshot_items
    WHERE snapshot_id = ?
  `).bind(openingId, previousClosing.id).run();

  return {
    openingId,
    sourceSnapshotId:Number(previousClosing.id),
    sourceSnapshotDate:previousClosing.snapshotDate,
  };
}



function previousCalendarDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function enumerateDates(dateFrom, dateTo) {
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return null;
  }

  const dates = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));

    if (dates.length > 366) {
      throw new Error(
        "O período máximo permitido é de 366 dias."
      );
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

async function rangePayload(db, dateFrom, dateTo, marker) {
  const dates = enumerateDates(dateFrom, dateTo);

  if (!dates) {
    throw new Error("O período informado é inválido.");
  }

  const baselineDate = previousCalendarDate(dateFrom);

  const [
    purchaseResult,
    revenueResult,
    closingResult,
    sectorPurchaseResult,
    sectorClosingResult,
    sectorRevenueResult,
  ] = await Promise.all([
    db.prepare(`
      SELECT
        purchase_date AS reportDate,
        SUM(
          CASE
            WHEN include_in_cmv = 1
              AND purchase_type = 'market'
            THEN amount_cents
            ELSE 0
          END
        ) AS marketCents,
        SUM(
          CASE
            WHEN include_in_cmv = 1
              AND purchase_type = 'supplier'
            THEN amount_cents
            ELSE 0
          END
        ) AS supplierCents,
        SUM(
          CASE
            WHEN payment_method = 'boleto'
              AND paid = 0
            THEN amount_cents
            ELSE 0
          END
        ) AS pendingBoletoCents
      FROM daily_purchases
      WHERE purchase_date BETWEEN ? AND ?
      GROUP BY purchase_date
    `).bind(dateFrom, dateTo).all(),

    db.prepare(`
      SELECT
        revenue_date AS reportDate,
        SUM(revenue_cents) AS revenueCents
      FROM daily_sector_revenue
      WHERE revenue_date BETWEEN ? AND ?
      GROUP BY revenue_date
    `).bind(dateFrom, dateTo).all(),

    db.prepare(`
      SELECT
        snapshot_date AS reportDate,
        total_cents AS totalCents,
        eligible_items AS eligibleItems,
        counted_items AS countedItems,
        missing_cost_items AS missingCostItems
      FROM inventory_snapshots
      WHERE snapshot_type = 'closing'
        AND snapshot_date BETWEEN ? AND ?
      ORDER BY snapshot_date
    `).bind(baselineDate, dateTo).all(),

    db.prepare(`
      SELECT
        purchase_date AS reportDate,
        CASE
          WHEN trim(purchase_sector) = ''
          THEN 'nao_classificado'
          ELSE purchase_sector
        END AS sector,
        SUM(amount_cents) AS purchasesCents
      FROM daily_purchases
      WHERE purchase_date BETWEEN ? AND ?
        AND include_in_cmv = 1
      GROUP BY
        purchase_date,
        CASE
          WHEN trim(purchase_sector) = ''
          THEN 'nao_classificado'
          ELSE purchase_sector
        END
    `).bind(dateFrom, dateTo).all(),

    db.prepare(`
      SELECT
        s.snapshot_date AS reportDate,
        CASE
          WHEN trim(i.sector) = ''
          THEN 'nao_classificado'
          ELSE i.sector
        END AS sector,
        SUM(COALESCE(i.value_cents, 0)) AS totalCents
      FROM inventory_snapshots s
      JOIN inventory_snapshot_items i
        ON i.snapshot_id = s.id
      WHERE s.snapshot_type = 'closing'
        AND s.snapshot_date BETWEEN ? AND ?
      GROUP BY
        s.snapshot_date,
        CASE
          WHEN trim(i.sector) = ''
          THEN 'nao_classificado'
          ELSE i.sector
        END
    `).bind(baselineDate, dateTo).all(),

    db.prepare(`
      SELECT
        revenue_date AS reportDate,
        sector,
        revenue_cents AS revenueCents
      FROM daily_sector_revenue
      WHERE revenue_date BETWEEN ? AND ?
    `).bind(dateFrom, dateTo).all(),
  ]);

  const purchaseByDate = new Map(
    (purchaseResult.results || []).map(row => [
      row.reportDate,
      {
        marketCents:Number(row.marketCents || 0),
        supplierCents:Number(row.supplierCents || 0),
        pendingBoletoCents:Number(row.pendingBoletoCents || 0),
      },
    ])
  );

  const revenueByDate = new Map(
    (revenueResult.results || []).map(row => [
      row.reportDate,
      Number(row.revenueCents || 0),
    ])
  );

  const closingByDate = new Map(
    (closingResult.results || []).map(row => [
      row.reportDate,
      {
        snapshotDate:row.reportDate,
        totalCents:Number(row.totalCents || 0),
        eligibleItems:Number(row.eligibleItems || 0),
        countedItems:Number(row.countedItems || 0),
        missingCostItems:Number(row.missingCostItems || 0),
      },
    ])
  );

  const sectorPurchasesByDate = new Map();

  for (const row of sectorPurchaseResult.results || []) {
    if (!sectorPurchasesByDate.has(row.reportDate)) {
      sectorPurchasesByDate.set(row.reportDate, new Map());
    }

    sectorPurchasesByDate
      .get(row.reportDate)
      .set(
        row.sector,
        Number(row.purchasesCents || 0)
      );
  }

  const sectorClosingByDate = new Map();

  for (const row of sectorClosingResult.results || []) {
    if (!sectorClosingByDate.has(row.reportDate)) {
      sectorClosingByDate.set(row.reportDate, new Map());
    }

    sectorClosingByDate
      .get(row.reportDate)
      .set(
        row.sector,
        Number(row.totalCents || 0)
      );
  }

  const sectorRevenueByDate = new Map();

  for (const row of sectorRevenueResult.results || []) {
    if (!sectorRevenueByDate.has(row.reportDate)) {
      sectorRevenueByDate.set(row.reportDate, new Map());
    }

    sectorRevenueByDate
      .get(row.reportDate)
      .set(
        row.sector,
        Number(row.revenueCents || 0)
      );
  }

  const days = dates.map(date => {
    const previousDate = previousCalendarDate(date);
    const previousClosing = closingByDate.get(previousDate) || null;
    const currentClosing = closingByDate.get(date) || null;

    const purchases = purchaseByDate.get(date) || {
      marketCents:0,
      supplierCents:0,
      pendingBoletoCents:0,
    };

    const previousClosingCents = previousClosing
      ? Number(previousClosing.totalCents)
      : null;

    const closingCents = currentClosing
      ? Number(currentClosing.totalCents)
      : null;

    const marketCents = Number(purchases.marketCents || 0);
    const supplierCents = Number(purchases.supplierCents || 0);
    const purchasesCents = marketCents + supplierCents;
    const revenueCents = Number(revenueByDate.get(date) || 0);

    const cmvReady =
      previousClosingCents !== null &&
      closingCents !== null;

    const cmvCents = cmvReady
      ? previousClosingCents +
        purchasesCents -
        closingCents
      : null;

    const cmvPercent =
      cmvReady && revenueCents > 0
        ? (cmvCents / revenueCents) * 100
        : null;

    return {
      date,
      previousClosingDate:previousDate,
      previousClosingCents,
      marketCents,
      supplierCents,
      purchasesCents,
      closingCents,
      revenueCents,
      cmvReady,
      cmvCents,
      cmvPercent,
      pendingBoletoCents:Number(
        purchases.pendingBoletoCents || 0
      ),
    };
  });

  const completedDays = days.filter(day => day.cmvReady);
  const sectorAccumulator = new Map();

  for (const day of completedDays) {
    const previousMap =
      sectorClosingByDate.get(day.previousClosingDate) ||
      new Map();

    const currentMap =
      sectorClosingByDate.get(day.date) ||
      new Map();

    const purchaseMap =
      sectorPurchasesByDate.get(day.date) ||
      new Map();

    const revenueMap =
      sectorRevenueByDate.get(day.date) ||
      new Map();

    const sectors = new Set([
      ...previousMap.keys(),
      ...currentMap.keys(),
      ...purchaseMap.keys(),
      ...revenueMap.keys(),
    ]);

    for (const sector of sectors) {
      const previousClosingCents =
        Number(previousMap.get(sector) || 0);

      const purchasesCents =
        Number(purchaseMap.get(sector) || 0);

      const closingCents =
        Number(currentMap.get(sector) || 0);

      const revenueCents =
        Number(revenueMap.get(sector) || 0);

      const cmvCents =
        previousClosingCents +
        purchasesCents -
        closingCents;

      const accumulated = sectorAccumulator.get(sector) || {
        sector,
        previousClosingCents:0,
        purchasesCents:0,
        closingCents:0,
        cmvCents:0,
        revenueCents:0,
        completedDays:0,
      };

      accumulated.previousClosingCents +=
        previousClosingCents;

      accumulated.purchasesCents += purchasesCents;
      accumulated.closingCents += closingCents;
      accumulated.cmvCents += cmvCents;
      accumulated.revenueCents += revenueCents;
      accumulated.completedDays += 1;

      sectorAccumulator.set(sector, accumulated);
    }
  }

  const sectorTotals = [...sectorAccumulator.values()]
    .map(sector => ({
      ...sector,
      cmvPercent:
        sector.revenueCents > 0
          ? (sector.cmvCents / sector.revenueCents) * 100
          : null,
    }))
    .sort((left, right) =>
      String(left.sector).localeCompare(
        String(right.sector),
        "pt-BR",
        { sensitivity:"base" }
      )
    );

  const totals = {
    totalDays:days.length,
    completedDays:completedDays.length,
    incompleteDays:days.length - completedDays.length,

    marketCents:days.reduce(
      (sum, day) => sum + day.marketCents,
      0
    ),

    supplierCents:days.reduce(
      (sum, day) => sum + day.supplierCents,
      0
    ),

    purchasesCents:days.reduce(
      (sum, day) => sum + day.purchasesCents,
      0
    ),

    pendingBoletoCents:days.reduce(
      (sum, day) => sum + day.pendingBoletoCents,
      0
    ),

    allRevenueCents:days.reduce(
      (sum, day) => sum + day.revenueCents,
      0
    ),

    completedRevenueCents:completedDays.reduce(
      (sum, day) => sum + day.revenueCents,
      0
    ),

    cmvCents:completedDays.reduce(
      (sum, day) => sum + Number(day.cmvCents || 0),
      0
    ),
  };

  totals.cmvPercent =
    totals.completedRevenueCents > 0 &&
    totals.completedDays > 0
      ? (
          totals.cmvCents /
          totals.completedRevenueCents
        ) * 100
      : null;

  return {
    schemaVersion:"daily-cmv-v27",
    reportType:"range",
    calculationMethod:"previous-closing",
    dbMarker:marker.slice(0, 8),
    dateFrom,
    dateTo,
    days,
    totals,
    sectorTotals,
  };
}

async function dailyPayload(db, date, marker) {
  const previousDate = previousCalendarDate(date);

  const [
    purchaseResult,
    revenue,
    closing,
    previousClosing,
    sectorRevenueResult,
  ] = await Promise.all([
    db.prepare(`
      SELECT
        id,
        purchase_date AS purchaseDate,
        purchase_type AS purchaseType,
        vendor,
        description,
        invoice_number AS invoiceNumber,
        amount_cents AS amountCents,
        amount_cents / 100.0 AS amount,
        payment_method AS paymentMethod,
        due_date AS dueDate,
        paid,
        include_in_cmv AS includeInCmv,
        notes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM daily_purchases
      WHERE purchase_date = ?
      ORDER BY created_at DESC, id DESC
    `).bind(date).all(),

    db.prepare(`
      SELECT
        revenue_date AS revenueDate,
        revenue_cents AS revenueCents,
        revenue_cents / 100.0 AS revenue,
        notes,
        updated_at AS updatedAt
      FROM daily_revenue
      WHERE revenue_date = ?
    `).bind(date).first(),

    db.prepare(`
      SELECT
        id,
        snapshot_date AS snapshotDate,
        snapshot_type AS snapshotType,
        recorded_by AS recordedBy,
        total_cents AS totalCents,
        total_cents / 100.0 AS total,
        eligible_items AS eligibleItems,
        counted_items AS countedItems,
        missing_cost_items AS missingCostItems,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM inventory_snapshots
      WHERE snapshot_date = ?
        AND snapshot_type = 'closing'
    `).bind(date).first(),

    db.prepare(`
      SELECT
        id,
        snapshot_date AS snapshotDate,
        snapshot_type AS snapshotType,
        recorded_by AS recordedBy,
        total_cents AS totalCents,
        total_cents / 100.0 AS total,
        eligible_items AS eligibleItems,
        counted_items AS countedItems,
        missing_cost_items AS missingCostItems,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM inventory_snapshots
      WHERE snapshot_date = ?
        AND snapshot_type = 'closing'
    `).bind(previousDate).first(),

    db.prepare(`
      SELECT
        sector,
        revenue_cents AS revenueCents
      FROM daily_sector_revenue
      WHERE revenue_date = ?
      ORDER BY sector
    `).bind(date).all(),
  ]);

  const purchases = purchaseResult.results || [];

  const cmvPurchases = purchases.filter(
    purchase => Number(purchase.includeInCmv) === 1
  );

  const marketCents = cmvPurchases
    .filter(purchase =>
      purchase.purchaseType === "market"
    )
    .reduce(
      (sum, purchase) =>
        sum + Number(purchase.amountCents),
      0
    );

  const supplierCents = cmvPurchases
    .filter(purchase =>
      purchase.purchaseType === "supplier"
    )
    .reduce(
      (sum, purchase) =>
        sum + Number(purchase.amountCents),
      0
    );

  const purchasesCents = marketCents + supplierCents;
  const sectorRevenue = sectorRevenueResult.results || [];

  const revenueCents = sectorRevenue.reduce(
    (sum, row) => sum + Number(row.revenueCents || 0),
    0
  );

  const previousClosingCents = previousClosing
    ? Number(previousClosing.totalCents)
    : null;

  const closingCents = closing
    ? Number(closing.totalCents)
    : null;

  const cmvReady =
    previousClosingCents !== null &&
    closingCents !== null;

  const cmvCents = cmvReady
    ? previousClosingCents +
      purchasesCents -
      closingCents
    : null;

  const cmvPercent =
    cmvReady && revenueCents > 0
      ? (cmvCents / revenueCents) * 100
      : null;

  const pendingBoletoCents = purchases
    .filter(purchase =>
      purchase.paymentMethod === "boleto" &&
      Number(purchase.paid) === 0
    )
    .reduce(
      (sum, purchase) =>
        sum + Number(purchase.amountCents),
      0
    );

  return {
    schemaVersion:"daily-cmv-v27",
    calculationMethod:"previous-closing",
    dbMarker:marker.slice(0, 8),
    date,
    previousDate,
    purchases,

    revenue:{
      revenueDate:date,
      revenueCents,
      revenue:revenueCents / 100,
      notes:revenue?.notes || "",
    },

    sectorRevenue,
    snapshots:{
      previousClosing:previousClosing || null,
      closing:closing || null,
    },

    summary:{
      previousClosingDate:previousDate,
      previousClosingCents,
      openingCents:previousClosingCents,
      marketCents,
      supplierCents,
      purchasesCents,
      closingCents,
      cmvReady,
      cmvCents,
      revenueCents,
      cmvPercent,
      pendingBoletoCents,
    },
  };
}

export async function onRequestGet(context) {
  const authError = requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);
    const marker = await getDatabaseMarker(db);

    const url = new URL(context.request.url);
    const rawFrom =
      url.searchParams.get("dateFrom") ||
      url.searchParams.get("from");
    const rawTo =
      url.searchParams.get("dateTo") ||
      url.searchParams.get("to");

    if (rawFrom || rawTo) {
      const dateFrom = normalizeDate(rawFrom);
      const dateTo = normalizeDate(rawTo);

      if (!dateFrom || !dateTo) {
        return json(
          { error:"Informe a data inicial e a data final." },
          400
        );
      }

      if (dateFrom > dateTo) {
        return json(
          { error:"A data inicial não pode ser posterior à data final." },
          400
        );
      }

      return json(
        await rangePayload(db, dateFrom, dateTo, marker)
      );
    }

    const date = normalizeDate(url.searchParams.get("date"));

    if (!date) {
      return json({ error:"Data inválida." }, 400);
    }

    return json(await dailyPayload(db, date, marker));
  } catch (error) {
    console.error(error);
    return json(
      {
        error:String(
          error?.message ||
          "Não foi possível carregar a gestão diária."
        ),
      },
      500
    );
  }
}

export async function onRequestPost(context) {
  const authError = requireAdmin(context.request, context.env);
  if (authError) return authError;

  try {
    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);
    const marker = await getDatabaseMarker(db);

    const body = await context.request.json();
    const action = cleanText(body.action, 40);

    if (action === "saveSectorRevenue") {
      const date = normalizeDate(body.date);
      const values =
        body.values && typeof body.values === "object"
          ? body.values
          : {};

      const validSectors = [
        "cozinha",
        "pizzaria",
        "bar",
        "vinhos",
      ];

      if (!date) {
        return json({ error:"Data inválida." }, 400);
      }

      const statements = [];

      for (const sector of validSectors) {
        const cents = normalizeMoneyToCents(
          values[sector],
          { allowNull:false }
        );

        if (cents === null) {
          return json(
            {
              error:
                `Informe um faturamento válido para ${sector}.`
            },
            400
          );
        }

        statements.push(
          db.prepare(`
            INSERT INTO daily_sector_revenue (
              revenue_date,
              sector,
              revenue_cents,
              updated_at
            )
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(revenue_date, sector)
            DO UPDATE SET
              revenue_cents = excluded.revenue_cents,
              updated_at = CURRENT_TIMESTAMP
          `).bind(date, sector, cents)
        );
      }

      await db.batch(statements);

      return json(await dailyPayload(db, date, marker));
    }

    if (action === "createPurchasesBatch") {
      const purchaseInputs = Array.isArray(body.purchases)
        ? body.purchases
        : [];

      if (!purchaseInputs.length || purchaseInputs.length > 200) {
        return json(
          { error:"Informe entre 1 e 200 linhas de compra." },
          400
        );
      }

      const purchases = purchaseInputs.map(parsePurchase);

      if (purchases.some(purchase => !purchase)) {
        return json(
          { error:"Revise as linhas da nota antes de lançar." },
          400
        );
      }

      const dates = new Set(
        purchases.map(purchase => purchase.purchaseDate)
      );

      if (dates.size !== 1) {
        return json(
          { error:"Todas as linhas devem usar a mesma data." },
          400
        );
      }

      const statements = purchases.map(purchase =>
        db.prepare(`
          INSERT INTO daily_purchases (
            purchase_date,
            purchase_type,
            vendor,
            purchase_sector,
            purchase_category,
            description,
            invoice_number,
            amount_cents,
            payment_method,
            due_date,
            paid,
            include_in_cmv,
            notes,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).bind(
          purchase.purchaseDate,
          purchase.purchaseType,
          purchase.vendor,
          purchase.purchaseSector,
          "",
          purchase.description,
          purchase.invoiceNumber,
          purchase.amountCents,
          purchase.paymentMethod,
          purchase.dueDate,
          purchase.paid,
          purchase.includeInCmv,
          purchase.notes,
        )
      );

      await db.batch(statements);

      const date = purchases[0].purchaseDate;

      return json({
        ...(await dailyPayload(db, date, marker)),
        importedCount:purchases.length,
      }, 201);
    }

    if (action === "createPurchase") {
      const purchase = parsePurchase(body.purchase || {});
      if (!purchase) {
        return json(
          { error: "Confira a compra e o valor informado." },
          400
        );
      }

      const result = await db.prepare(`
        INSERT INTO daily_purchases (
          purchase_date,
          purchase_type,
          vendor,
          purchase_sector,
          purchase_category,
          description,
          invoice_number,
          amount_cents,
          payment_method,
          due_date,
          paid,
          include_in_cmv,
          notes,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        purchase.purchaseDate,
        purchase.purchaseType,
        purchase.vendor,
        purchase.purchaseSector,
        purchase.purchaseCategory,
        purchase.description,
        purchase.invoiceNumber,
        purchase.amountCents,
        purchase.paymentMethod,
        purchase.dueDate,
        purchase.paid,
        purchase.includeInCmv,
        purchase.notes,
      ).run();

      const id = Number(result.meta?.last_row_id);
      const savedPurchase = await readPurchase(db, id);

      return json({
        ...(await dailyPayload(db, purchase.purchaseDate, marker)),
        savedPurchase,
      }, 201);
    }

    if (action === "updatePurchase") {
      const id = Number(body.id);
      const purchase = parsePurchase(body.purchase || {});

      if (!Number.isInteger(id) || id <= 0 || !purchase) {
        return json({ error: "Compra inválida." }, 400);
      }

      const result = await db.prepare(`
        UPDATE daily_purchases SET
          purchase_date = ?,
          purchase_type = ?,
          vendor = ?,
          purchase_sector = ?,
          purchase_category = ?,
          description = ?,
          invoice_number = ?,
          amount_cents = ?,
          payment_method = ?,
          due_date = ?,
          paid = ?,
          include_in_cmv = ?,
          notes = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        purchase.purchaseDate,
        purchase.purchaseType,
        purchase.vendor,
        purchase.purchaseSector,
        purchase.purchaseCategory,
        purchase.description,
        purchase.invoiceNumber,
        purchase.amountCents,
        purchase.paymentMethod,
        purchase.dueDate,
        purchase.paid,
        purchase.includeInCmv,
        purchase.notes,
        id,
      ).run();

      if (!result.meta?.changes) {
        return json({ error: "Compra não encontrada." }, 404);
      }

      return json(
        await dailyPayload(db, purchase.purchaseDate, marker)
      );
    }

    if (action === "deletePurchase") {
      const id = Number(body.id);
      const date = normalizeDate(body.date);

      if (!Number.isInteger(id) || id <= 0 || !date) {
        return json({ error: "Dados inválidos." }, 400);
      }

      await db
        .prepare("DELETE FROM daily_purchases WHERE id = ?")
        .bind(id)
        .run();

      return json(await dailyPayload(db, date, marker));
    }
    if (action === "captureSnapshot") {
      const date = normalizeDate(body.date);
      const type = cleanText(body.type, 20);
      const recordedBy = cleanText(body.recordedBy, 120);

      if (!date || !SNAPSHOT_TYPES.has(type)) {
        return json({ error:"Fechamento inválido." }, 400);
      }

      await captureSnapshot(db, date, type, recordedBy);
      return json(await dailyPayload(db, date, marker));
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (error) {
    console.error(error);
    return json(
      { error: String(error?.message || "Não foi possível salvar.") },
      500
    );
  }
}
