import {
  cleanText,
  ensureDatabase,
  json,
  requireAdmin,
} from "../_lib/db.js";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const MAX_FILE_BYTES = 12 * 1024 * 1024;

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunkSize)
    );
  }

  return btoa(binary);
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") {
    return payload.output_text;
  }

  const parts = [];

  for (const output of payload?.output || []) {
    for (const content of output?.content || []) {
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n");
}

function parseJsonText(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  return JSON.parse(normalized);
}


function normalizeSector(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["cozinha", "pizzaria", "bar", "vinhos"].includes(text)
    ? text
    : "";
}

function normalizeCatalogText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\b(KG|KGS|GR|G|UN|UND|UNID|UNIDADE|ML|L|LT|LTS|CX|PCT|PC|BDJ)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeCatalogText(value).split(" ").filter(Boolean));
}

function diceSimilarity(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

function prefixSimilarity(left, right) {
  const a = normalizeCatalogText(left);
  const b = normalizeCatalogText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }

  let same = 0;
  const limit = Math.min(a.length, b.length);
  while (same < limit && a[same] === b[same]) same += 1;
  return same / Math.max(a.length, b.length);
}

function catalogSimilarity(left, right) {
  return Math.max(
    diceSimilarity(left, right),
    prefixSimilarity(left, right)
  );
}

function bestCatalogMatch(description, catalog) {
  let best = null;

  for (const item of catalog) {
    const score = catalogSimilarity(description, item.name);
    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best;
}

function normalizeAnalysis(raw, filename, catalog, aliases) {
  const lines = Array.isArray(raw?.lines) ? raw.lines : [];
  const catalogById = new Map(catalog.map(item => [Number(item.id), item]));
  const catalogByName = new Map(
    catalog.map(item => [normalizeCatalogText(item.name), item])
  );
  const aliasByText = new Map(
    aliases.map(alias => [String(alias.normalizedAlias), catalogById.get(Number(alias.itemId))])
  );

  return {
    filename,
    vendor:cleanText(raw?.vendor, 160),
    invoiceNumber:cleanText(raw?.invoiceNumber, 80),
    invoiceDate:cleanText(raw?.invoiceDate, 20),
    total:Number(raw?.total || 0),
    lines:lines
      .map((line, index) => {
        const description = cleanText(line?.description, 240);
        const normalized = normalizeCatalogText(description);
        const exactAlias = aliasByText.get(normalized);
        const exactName = catalogByName.get(normalized);
        const similar = bestCatalogMatch(description, catalog);

        let matchedItem = exactAlias || exactName || null;
        let matchMethod = exactAlias
          ? "de-para"
          : exactName
            ? "nome exato"
            : "";
        let matchConfidence = matchedItem ? 1 : 0;

        if (!matchedItem && similar && similar.score >= 0.72) {
          matchedItem = similar.item;
          matchMethod = "similaridade";
          matchConfidence = similar.score;
        }

        if (!matchedItem) {
          const aiName = normalizeCatalogText(line?.suggestedItemName);
          const aiItem = catalogByName.get(aiName);
          if (aiItem) {
            matchedItem = aiItem;
            matchMethod = "IA";
            matchConfidence = Math.max(
              0,
              Math.min(1, Number(line?.confidence || 0))
            );
          }
        }

        const sector = matchedItem?.sector || normalizeSector(line?.sector);
        const category = matchedItem?.category || cleanText(line?.category, 120);

        return {
          id:index + 1,
          description,
          quantity:Number(line?.quantity || 0),
          unit:cleanText(line?.unit, 30),
          unitPrice:Number(line?.unitPrice || 0),
          total:Number(line?.total || 0),
          itemId:matchedItem ? Number(matchedItem.id) : null,
          itemName:matchedItem?.name || "",
          sector,
          category,
          matchMethod:matchMethod || "IA sem item",
          matchConfidence,
          confidence:Math.max(
            0,
            Math.min(1, Number(line?.confidence || 0))
          ),
        };
      })
      .filter(line =>
        line.description &&
        Number.isFinite(line.total) &&
        line.total >= 0
      ),
  };
}

export async function onRequestPost(context) {
  const authError = requireAdmin(
    context.request,
    context.env
  );

  if (authError) return authError;

  if (!context.env.OPENAI_API_KEY) {
    return json(
      {
        error:
          "Cadastre o segredo OPENAI_API_KEY no Cloudflare.",
      },
      503
    );
  }

  try {
    const form = await context.request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return json(
        { error:"Selecione uma foto ou PDF da nota." },
        400
      );
    }

    if (
      file.size <= 0 ||
      file.size > MAX_FILE_BYTES
    ) {
      return json(
        { error:"O arquivo deve ter no máximo 12 MB." },
        400
      );
    }

    const mimeType = String(
      file.type || "application/octet-stream"
    ).toLowerCase();

    if (!ALLOWED_TYPES.has(mimeType)) {
      return json(
        {
          error:
            "Envie PDF, JPG, PNG, WEBP, HEIC ou HEIF.",
        },
        400
      );
    }

    const db = context.env.DB.withSession("first-primary");
    await ensureDatabase(db);

    const [catalogResult, aliasResult] = await Promise.all([
      db.prepare(`
        SELECT id, name, category, sector
        FROM items
        WHERE active = 1
          AND sector IN (
            'cozinha',
            'pizzaria',
            'bar',
            'vinhos'
          )
        ORDER BY sector, category, name
      `).all(),
      db.prepare(`
        SELECT
          alias,
          normalized_alias AS normalizedAlias,
          item_id AS itemId
        FROM item_aliases
      `).all(),
    ]);

    const catalogItems = (catalogResult.results || []).slice(0, 500);
    const aliases = aliasResult.results || [];

    const catalog = catalogItems
      .map(item =>
        `${item.name} => setor:${item.sector}; categoria:${item.category || ""}`
      )
      .join("\n");

    const bytes = new Uint8Array(
      await file.arrayBuffer()
    );

    const base64 = bytesToBase64(bytes);

    const prompt = `
Leia esta nota fiscal, cupom, DANFE ou documento de compra de restaurante.

Extraia cada linha comprada separadamente e classifique em apenas um setor:
- cozinha: alimentos e insumos usados nos pratos, inclusive carnes, pescados, hortifruti, laticínios, secos e limpeza de cozinha;
- pizzaria: farinha de pizza, fermento, molho, mozzarella e ingredientes predominantemente da pizza;
- bar: refrigerantes, água, cervejas, destilados, frutas e xaropes do bar;
- vinhos: garrafas de vinho, espumantes e similares.

Não use o setor salão.
Não agrupe linhas diferentes.
Desconsidere impostos, frete, descontos, formas de pagamento e totais que não sejam produtos, mas preserve o total líquido da linha.
Quando uma linha não estiver legível, mantenha a melhor leitura e reduza confidence.
A classificação final será decidida pelo sistema nesta ordem:
1. de-para já aprendido;
2. nome exato;
3. similaridade;
4. sua sugestão somente quando os anteriores não encontrarem item.

Para cada linha, sugira também o nome EXATO de um item do catálogo quando houver correspondência razoável.
Se não houver item razoável, deixe suggestedItemName vazio.
Use o catálogo abaixo:
${catalog}

Responda SOMENTE com JSON válido neste formato:
{
  "vendor": "nome do fornecedor",
  "invoiceNumber": "número da nota",
  "invoiceDate": "AAAA-MM-DD ou vazio",
  "total": 0.00,
  "lines": [
    {
      "description": "produto",
      "quantity": 0,
      "unit": "kg/un/L/etc",
      "unitPrice": 0.00,
      "total": 0.00,
      "suggestedItemName": "nome exato do catálogo ou vazio",
      "sector": "cozinha|pizzaria|bar|vinhos",
      "category": "categoria sugerida ou vazio",
      "confidence": 0.0
    }
  ]
}
`.trim();

    const fileInput =
      mimeType === "application/pdf"
        ? {
            type:"input_file",
            filename:file.name || "nota.pdf",
            file_data:base64,
          }
        : {
            type:"input_image",
            image_url:
              `data:${mimeType};base64,${base64}`,
            detail:"high",
          };

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method:"POST",
        headers:{
          "content-type":"application/json",
          "authorization":
            `Bearer ${context.env.OPENAI_API_KEY}`,
        },
        body:JSON.stringify({
          model:
            context.env.OPENAI_INVOICE_MODEL ||
            "gpt-5-mini",
          input:[
            {
              role:"user",
              content:[
                {
                  type:"input_text",
                  text:prompt,
                },
                fileInput,
              ],
            },
          ],
        }),
      }
    );

    const payload = await response.json();

    if (!response.ok) {
      console.error("OpenAI invoice error", payload);

      return json(
        {
          error:
            payload?.error?.message ||
            "A IA não conseguiu analisar a nota.",
        },
        502
      );
    }

    const text = responseText(payload);
    const parsed = parseJsonText(text);
    const analysis = normalizeAnalysis(
      parsed,
      file.name || "nota",
      catalogItems,
      aliases
    );

    if (!analysis.lines.length) {
      return json(
        {
          error:
            "Nenhuma linha de produto foi encontrada. Tente uma foto mais nítida.",
        },
        422
      );
    }

    return json({
      schemaVersion:"invoice-import-v28",
      analysis,
      catalog:catalogItems,
    });
  } catch (error) {
    console.error(error);

    return json(
      {
        error:String(
          error?.message ||
          "Não foi possível analisar a nota."
        ),
      },
      500
    );
  }
}
