import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const OUT_FILE =
  process.env.REVIEW_EXPORT_FILE ||
  "/root/costudy-frontend/migration-input/new-corpus/review_queue.csv";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function esc(v) {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

async function main() {
  const { data, error } = await supabase
    .from("ingestion_staging")
    .select("id,source_file,source_row_number,part,section,topic,question_type,question_text,answer_key,quality_score,quality_bucket,quality_notes,status")
    .eq("status", "PENDING_REVIEW")
    .order("quality_score", { ascending: false })
    .limit(50000);
  if (error) throw error;

  const rows = data || [];
  const header = [
    "id",
    "source_file",
    "source_row_number",
    "part",
    "section",
    "topic",
    "question_type",
    "question_text",
    "answer_key",
    "quality_score",
    "quality_bucket",
    "quality_notes",
    "status",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.source_file,
        r.source_row_number,
        r.part,
        r.section,
        r.topic,
        r.question_type,
        r.question_text,
        r.answer_key,
        r.quality_score,
        r.quality_bucket,
        JSON.stringify(r.quality_notes || {}),
        r.status,
      ]
        .map(esc)
        .join(",")
    );
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  console.log(`[review-export] wrote ${rows.length} rows to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("[review-export] failed", e);
  process.exit(1);
});
