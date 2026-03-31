import dotenv from "dotenv";
dotenv.config({ override: true });
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY"
  );
}

const CHUNK_PAGE_SIZE = Number(process.env.BACKFILL_CHUNK_PAGE_SIZE || 200);
const EMBED_BATCH_SIZE = Number(process.env.BACKFILL_EMBED_BATCH_SIZE || 50);
const MAX_ROWS = Number(process.env.BACKFILL_MAX_ROWS || 50000);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function sanitizeText(s) {
  return String(s || "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .trim();
}

async function fetchChunkPage(page, pageSize) {
  const from = page * pageSize;
  const to = from + pageSize - 1;
  const { data, error } = await supabase
    .from("content_chunks")
    .select("id, content")
    .order("created_at", { ascending: true })
    .range(from, to);
  if (error) throw error;
  return data || [];
}

async function fetchEmbeddedSet(chunkIds) {
  if (chunkIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("content_embeddings")
    .select("chunk_id")
    .in("chunk_id", chunkIds);
  if (error) throw error;
  return new Set((data || []).map((r) => r.chunk_id));
}

async function embedAndUpsert(rows) {
  if (!rows.length) return 0;
  const inputs = rows.map((r) => sanitizeText(r.content).slice(0, 8000));
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: inputs,
  });
  const payload = rows.map((r, idx) => ({
    chunk_id: r.id,
    embedding: response.data[idx].embedding,
    model: EMBED_MODEL,
  }));
  const UPSERT_BATCH = 25;
  for (let i = 0; i < payload.length; i += UPSERT_BATCH) {
    const slice = payload.slice(i, i + UPSERT_BATCH);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error } = await supabase
        .from("content_embeddings")
        .upsert(slice, { onConflict: "chunk_id" });
      if (!error) break;
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return payload.length;
}

async function main() {
  console.log(
    `[backfill] start model=${EMBED_MODEL} pageSize=${CHUNK_PAGE_SIZE} embedBatch=${EMBED_BATCH_SIZE} maxRows=${MAX_ROWS}`
  );
  let page = 0;
  let scanned = 0;
  let embedded = 0;

  while (scanned < MAX_ROWS) {
    const rows = await fetchChunkPage(page, CHUNK_PAGE_SIZE);
    if (!rows.length) break;
    scanned += rows.length;
    page += 1;

    const embeddedSet = await fetchEmbeddedSet(rows.map((r) => r.id));
    const missing = rows.filter((r) => !embeddedSet.has(r.id) && sanitizeText(r.content));
    if (!missing.length) {
      if (page % 10 === 0) console.log(`[backfill] scanned=${scanned}, embedded=${embedded}`);
      continue;
    }

    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
      embedded += await embedAndUpsert(batch);
    }

    console.log(`[backfill] scanned=${scanned}, embedded=${embedded}`);
  }

  console.log(`[backfill] completed scanned=${scanned}, embedded=${embedded}`);
}

main().catch((e) => {
  console.error("[backfill] failed", e);
  process.exit(1);
});
