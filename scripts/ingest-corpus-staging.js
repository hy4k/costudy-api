import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parse } from "csv-parse";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORPUS_DIR =
  process.env.CORPUS_DIR ||
  "/root/costudy-frontend/migration-input/new-corpus";
const SOURCE_KIND = process.env.CORPUS_SOURCE_KIND || "uploaded_corpus";
const BATCH_SIZE = Number(process.env.CORPUS_INGEST_BATCH || 200);

function cleanText(v) {
  if (v === undefined || v === null) return "";
  return String(v)
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForHash(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTags(v) {
  const c = cleanText(v);
  if (!c) return [];
  try {
    const parsed = JSON.parse(c);
    if (Array.isArray(parsed)) return parsed.map((x) => cleanText(x)).filter(Boolean);
  } catch {
    // fall through
  }
  return c
    .split(",")
    .map((x) => cleanText(x))
    .filter(Boolean);
}

function parseOptions(row) {
  const a = cleanText(row.option_a);
  const b = cleanText(row.option_b);
  const c = cleanText(row.option_c);
  const d = cleanText(row.option_d);
  const hasAny = a || b || c || d;
  if (!hasAny) return null;
  return { A: a, B: b, C: c, D: d };
}

function qualityScoreRecord(record) {
  let score = 100;
  const notes = {};
  const q = cleanText(record.question_text);
  const answer = cleanText(record.answer_key);
  const explanation = cleanText(record.explanation);
  const isMcq = record.question_type === "MCQ";

  if (!record.license_ok) {
    score -= 60;
    notes.license = "license_not_confirmed";
  }
  if (q.length < 40) {
    score -= 25;
    notes.question_too_short = q.length;
  }
  if (q.length > 5000) {
    score -= 10;
    notes.question_too_long = q.length;
  }
  if (isMcq) {
    const options = record.options || {};
    const optionCount = ["A", "B", "C", "D"].filter((k) => cleanText(options[k])).length;
    if (optionCount < 4) {
      score -= 30;
      notes.missing_options = optionCount;
    }
    if (!answer || !/^[A-D]$/i.test(answer)) {
      score -= 25;
      notes.invalid_answer_key = answer || null;
    }
  } else if (!explanation && !answer) {
    score -= 20;
    notes.missing_essay_guidance = true;
  }
  const weirdRatio =
    q.length === 0
      ? 1
      : (q.match(/[^a-zA-Z0-9\s.,;:()\-/?%$'"&]/g)?.length || 0) / q.length;
  if (weirdRatio > 0.12) {
    score -= 15;
    notes.noisy_text_ratio = Number(weirdRatio.toFixed(3));
  }

  score = Math.max(0, Math.min(100, score));
  const quality_bucket = score >= 80 ? "APPROVE" : score >= 60 ? "REVIEW" : "REJECT";
  return { score, quality_bucket, notes };
}

function mapRowToStaging(row, sourceFile, rowNumber) {
  const question_type = cleanText(row.question_type || row.type || "MCQ").toUpperCase() === "ESSAY" ? "ESSAY" : "MCQ";
  const question_text = cleanText(row.question_text || row.question || row.prompt);
  const answer_key = cleanText(row.answer_key || row.correct_answer);
  const explanation = cleanText(row.explanation || row.answer_explanation || row.answer_text);
  const options = question_type === "MCQ" ? parseOptions(row) : null;
  const part = cleanText(row.part);
  const section = cleanText(row.section);
  const topic = cleanText(row.topic || row.syllabus_topic);
  const difficulty = cleanText(row.difficulty);
  const tags = parseTags(row.tags || row.topics);
  const license_ok = String(row.license_ok || "").toLowerCase() === "true" || String(row.license_ok || "") === "1";

  const normalized_hash = crypto
    .createHash("sha256")
    .update(
      [
        normalizeForHash(question_text),
        normalizeForHash(answer_key),
        normalizeForHash(explanation),
      ].join("|")
    )
    .digest("hex");

  const base = {
    source_file: sourceFile,
    source_row_number: rowNumber,
    source_kind: SOURCE_KIND,
    part: part || null,
    section: section || null,
    topic: topic || null,
    question_type,
    question_text,
    options,
    answer_key: answer_key || null,
    explanation: explanation || null,
    difficulty: difficulty || null,
    tags,
    license_ok,
    normalized_hash,
  };

  const quality = qualityScoreRecord(base);

  return {
    ...base,
    quality_score: quality.score,
    quality_bucket: quality.quality_bucket,
    quality_notes: quality.notes,
  };
}

async function upsertBatch(rows) {
  if (!rows.length) return 0;
  const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i].normalized_hash;
    seen.set(key, i);
  }
  const deduped = [...seen.values()].map((i) => rows[i]);
  const { error } = await supabase.from("ingestion_staging").upsert(deduped, {
    onConflict: "normalized_hash",
  });
  if (error) throw error;
  return deduped.length;
}

async function ingestOneFile(filePath) {
  const fileName = path.basename(filePath);
  let processed = 0;
  let batch = [];

  await new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
    let rowNumber = 0;

    parser.on("data", async (row) => {
      rowNumber += 1;
      const mapped = mapRowToStaging(row, fileName, rowNumber);
      if (!mapped.question_text) return;
      batch.push(mapped);
      if (batch.length >= BATCH_SIZE) {
        parser.pause();
        upsertBatch(batch)
          .then((n) => {
            processed += n;
            batch = [];
            parser.resume();
          })
          .catch(reject);
      }
    });

    parser.on("error", reject);
    parser.on("end", async () => {
      try {
        processed += await upsertBatch(batch);
        resolve();
      } catch (e) {
        reject(e);
      }
    });

    fs.createReadStream(filePath).pipe(parser);
  });

  console.log(`[ingest] ${fileName}: processed=${processed}`);
  return processed;
}

async function main() {
  if (!fs.existsSync(CORPUS_DIR)) {
    throw new Error(`Corpus directory not found: ${CORPUS_DIR}`);
  }

  const files = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(CORPUS_DIR, f));

  if (!files.length) {
    console.log(`[ingest] no csv files in ${CORPUS_DIR}`);
    return;
  }

  let total = 0;
  console.log(`[ingest] files=${files.length}`);
  for (const file of files) {
    total += await ingestOneFile(file);
  }
  console.log(`[ingest] completed total=${total}`);
}

main().catch((e) => {
  console.error("[ingest] failed", e);
  process.exit(1);
});
