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
  const text = String(value || "")
    .trim()
    .toLowerCase();

  if (["cozinha", "pizzaria", "bar", "vinhos"].includes(text)) {
    return text;
  }

  return "cozinha";
}

function normalizeAnalysis(raw, filename) {
  const lines = Array.isArray(raw?.lines) ? raw.lines : [];

  return {
    filename,
    vendor:cleanText(raw?.vendor, 160),
    invoiceNumber:cleanText(raw?.invoiceNumber, 80),
    invoiceDate:cleanText(raw?.invoiceDate, 20),
    total:Number(raw?.total || 0),
    lines:lines
      .map((line, index) => ({
        id:index + 1,
        description:cleanText(line?.description, 240),
        quantity:Number(line?.quantity || 0),
        unit:cleanText(line?.unit, 30),
        unitPrice:Number(line?.unitPrice || 0),
        total:Number(line?.total || 0),
        sector:normalizeSector(line?.sector),
        confidence:Math.max(
          0,
          Math.min(1, Number(line?.confidence || 0))
        ),
      }))
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

    const catalogResult = await db.prepare(`
      SELECT name, sector
      FROM items
      WHERE active = 1
        AND sector IN (
          'cozinha',
          'pizzaria',
          'bar',
          'vinhos'
        )
      ORDER BY sector, name
    `).all();

    const catalog = (catalogResult.results || [])
      .slice(0, 250)
      .map(item => `${item.name} => ${item.sector}`)
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
Use o catálogo abaixo somente como referência de classificação:
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
      "sector": "cozinha|pizzaria|bar|vinhos",
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
      file.name || "nota"
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
      schemaVersion:"invoice-import-v27",
      analysis,
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
