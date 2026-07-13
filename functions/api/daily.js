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
const SNAPSHOT_TYPES = new Set(["opening", "closing"]);

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
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(snapshot_date, snapshot_type)
    DO UPDATE SET
      recorded_by = excluded.recorded_by,
      total_cents = excluded.total_cents,
      eligible_items = excluded.eligible_items,
      counted_items = excluded.counted_items,
      missing_cost_items = excluded.missing_cost_items,
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

async function dailyPayload(db, date, marker) {
  const [purchaseResult, revenue, snapshotResult] = await Promise.all([
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
      ORDER BY snapshot_type
    `).bind(date).all(),
  ]);

  const purchases = purchaseResult.results || [];
  const snapshots = snapshotResult.results || [];

  const opening = snapshots.find(
    snapshot => snapshot.snapshotType === "opening"
  ) || null;

  const closing = snapshots.find(
    snapshot => snapshot.snapshotType === "closing"
  ) || null;

  const cmvPurchases = purchases.filter(
    purchase => Number(purchase.includeInCmv) === 1
  );

  const marketCents = cmvPurchases
    .filter(purchase => purchase.purchaseType === "market")
    .reduce((sum, purchase) => sum + Number(purchase.amountCents), 0);

  const supplierCents = cmvPurchases
    .filter(purchase => purchase.purchaseType === "supplier")
    .reduce((sum, purchase) => sum + Number(purchase.amountCents), 0);

  const purchasesCents = marketCents + supplierCents;
  const revenueCents = Number(revenue?.revenueCents || 0);

  const cmvReady = Boolean(opening && closing);
  const cmvCents = cmvReady
    ? Number(opening.totalCents) +
      purchasesCents -
      Number(closing.totalCents)
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
    .reduce((sum, purchase) => sum + Number(purchase.amountCents), 0);

  return {
    schemaVersion: "daily-cmv-v7",
    dbMarker: marker.slice(0, 8),
    date,
    purchases,
    revenue: revenue || {
      revenueDate: date,
      revenueCents: 0,
      revenue: 0,
      notes: "",
    },
    snapshots: {
      opening,
      closing,
    },
    summary: {
      openingCents: opening ? Number(opening.totalCents) : null,
      marketCents,
      supplierCents,
      purchasesCents,
      closingCents: closing ? Number(closing.totalCents) : null,
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
    const date = normalizeDate(url.searchParams.get("date"));

    if (!date) {
      return json({ error: "Data inválida." }, 400);
    }

    return json(await dailyPayload(db, date, marker));
  } catch (error) {
    console.error(error);
    return json(
      { error: "Não foi possível carregar a gestão diária." },
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

    if (action === "saveRevenue") {
      const date = normalizeDate(body.date);
      const revenueCents = normalizeMoneyToCents(
        body.revenue,
        { allowNull: false }
      );
      const notes = cleanText(body.notes, 500);

      if (!date || revenueCents === null) {
        return json(
          { error: "Informe uma data e um faturamento válidos." },
          400
        );
      }

      await db.prepare(`
        INSERT INTO daily_revenue (
          revenue_date,
          revenue_cents,
          notes,
          updated_at
        )
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(revenue_date)
        DO UPDATE SET
          revenue_cents = excluded.revenue_cents,
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `).bind(date, revenueCents, notes).run();

      return json(await dailyPayload(db, date, marker));
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).bind(
        purchase.purchaseDate,
        purchase.purchaseType,
        purchase.vendor,
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
        return json({ error: "Fechamento inválido." }, 400);
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
