/**
 * Offline / CLI question-bank builder.
 *
 * Usage (on a machine with service role + OpenAI not required for regex path):
 *   node scripts/extract-question-bank.mjs --limit 500 --offset 0
 *   node scripts/extract-question-bank.mjs --dry-run --limit 50
 *
 * Env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_API_KEY (optional — if set, prefers live API extract endpoint)
 *   COSTUDY_API_URL (default https://api.costudy.in)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { parseMcqFromChunk, sanitizeText } from "../lib/ragEngine.js";

const limit = Number(process.argv.find((a, i) => process.argv[i - 1] === "--limit") || 300);
const offset = Number(process.argv.find((a, i) => process.argv[i - 1] === "--offset") || 0);
const dryRun = process.argv.includes("--dry-run");
const useApi = process.argv.includes("--via-api");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const API_URL = process.env.COSTUDY_API_URL || "https://api.costudy.in";

async function viaApi() {
  if (!ADMIN_API_KEY) throw new Error("ADMIN_API_KEY required for --via-api");
  const res = await fetch(`${API_URL}/api/admin/question-bank/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": ADMIN_API_KEY,
    },
    body: JSON.stringify({ limit, offset, dryRun }),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

async function viaDirect() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: chunks, error } = await sb
    .from("content_chunks")
    .select("id,document_id,page_number,chunk_type,question_no,content")
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const extracted = [];
  for (const ch of chunks || []) {
    const items = parseMcqFromChunk(ch.content);
    for (const item of items) {
      extracted.push({
        stem: item.stem,
        choices: item.choices,
        correct_key: item.correct_key,
        explanation: item.explanation,
        topic: null,
        difficulty: "medium",
        source_chunk_id: ch.id,
        source_document: ch.document_id,
        question_no: item.question_no || ch.question_no,
        is_active: true,
        metadata: { page_number: ch.page_number, chunk_type: ch.chunk_type },
      });
    }
  }

  console.log(`Scanned ${chunks?.length || 0} chunks → extracted ${extracted.length} MCQs`);
  if (dryRun) {
    console.log("Sample:", JSON.stringify(extracted.slice(0, 2), null, 2));
    return;
  }

  let ok = 0;
  for (let i = 0; i < extracted.length; i += 40) {
    const batch = extracted.slice(i, i + 40);
    const { error: insErr } = await sb.from("practice_question_bank").insert(batch);
    if (insErr) {
      console.warn("batch error", insErr.message);
      // try one-by-one
      for (const row of batch) {
        const { error: e2 } = await sb.from("practice_question_bank").insert(row);
        if (!e2) ok += 1;
      }
    } else {
      ok += batch.length;
    }
  }
  console.log(`Inserted/attempted rows: ${ok}`);
}

const main = useApi ? viaApi : viaDirect;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
