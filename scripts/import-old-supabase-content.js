import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import path from "path";
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

const DATA_DIR =
  process.env.OLD_EXPORT_DATA_DIR ||
  "/root/costudy-frontend/migration-input/old-supabase/data";

const QUESTIONS_CSV = path.join(DATA_DIR, "questions.csv");
const ESSAYS_CSV = path.join(DATA_DIR, "essay_questions.csv");
const DOC_SECTIONS_CSV = path.join(DATA_DIR, "document_sections.csv");

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === "\\N" || s === "null" || s === "NULL") return null;
  return s;
}

function toInt(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseRefs(v) {
  const c = cleanText(v);
  if (!c) return [];
  try {
    const parsed = JSON.parse(c);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return [c];
  }
}

function parseTopicTags(v) {
  const c = cleanText(v);
  if (!c) return [];
  try {
    const parsed = JSON.parse(c);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // not JSON, parse as comma-separated
  }
  return c
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function getOrCreateSource(sourceKind, name) {
  const { data: existing, error: selErr } = await supabase
    .from("content_sources")
    .select("id")
    .eq("source_kind", sourceKind)
    .eq("name", name)
    .limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length > 0) return existing[0].id;

  const { data, error } = await supabase
    .from("content_sources")
    .insert([{ source_kind: sourceKind, name }])
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function upsertBatched(table, rows, onConflict) {
  if (!rows.length) return 0;
  const conflictCols = onConflict.split(",").map((x) => x.trim());
  const deduped = [];
  const seen = new Map();

  for (const row of rows) {
    const key = conflictCols.map((c) => String(row[c] ?? "")).join("::");
    if (seen.has(key)) {
      deduped[seen.get(key)] = row;
    } else {
      seen.set(key, deduped.length);
      deduped.push(row);
    }
  }

  const { error } = await supabase.from(table).upsert(deduped, { onConflict });
  if (error) throw error;
  return deduped.length;
}

async function importQuestions() {
  if (!fileExists(QUESTIONS_CSV)) {
    console.log("[questions] not found, skipping");
    return 0;
  }

  console.log("[questions] importing", QUESTIONS_CSV);
  let total = 0;
  let batch = [];
  const batchSize = 300;

  await new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    parser.on("data", async (row) => {
        batch.push({
          external_id: cleanText(row.id),
          part: cleanText(row.part) || "Part 1",
          section: cleanText(row.section),
          topic: cleanText(row.syllabus_topic) || cleanText(row.topic),
          question_kind: "MCQ",
          difficulty: cleanText(row.difficulty) || "MEDIUM",
          source_kind: "old_self_host",
          question_text: cleanText(row.question_text) || "Missing question text",
          options: {
            A: cleanText(row.option_a),
            B: cleanText(row.option_b),
            C: cleanText(row.option_c),
            D: cleanText(row.option_d),
          },
          correct_answer: cleanText(row.correct_answer),
          explanation: cleanText(row.explanation),
          reference_links: [],
          tags: parseTopicTags(row.topics),
          is_active: true,
        });

        if (batch.length >= batchSize) {
          parser.pause();
          upsertBatched("question_bank", batch, "external_id")
            .then((n) => {
              total += n;
              batch = [];
              if (total % 1500 === 0) {
                console.log(`[questions] processed ${total}`);
              }
              parser.resume();
            })
            .catch(reject);
        }
      })
      .on("error", reject)
      .on("end", async () => {
        try {
          total += await upsertBatched("question_bank", batch, "external_id");
          resolve();
        } catch (e) {
          reject(e);
        }
      });

    fs.createReadStream(QUESTIONS_CSV).pipe(parser);
  });

  console.log(`[questions] done: ${total}`);
  return total;
}

async function importEssays() {
  if (!fileExists(ESSAYS_CSV)) {
    console.log("[essays] not found, skipping");
    return 0;
  }

  console.log("[essays] importing", ESSAYS_CSV);
  let total = 0;
  let batch = [];
  const batchSize = 200;

  await new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    parser.on("data", async (row) => {
        const scenario = cleanText(row.scenario) || "";
        const tasks = cleanText(row.tasks) || "";
        batch.push({
          external_id: cleanText(row.id),
          part: cleanText(row.part) || "Part 1",
          section: "Essay",
          topic: cleanText(row.topic),
          question_kind: "ESSAY",
          difficulty: cleanText(row.difficulty) || "MEDIUM",
          source_kind: "old_self_host",
          question_text: `${scenario}\n\n${tasks}`.trim() || "Missing essay text",
          options: null,
          correct_answer: null,
          explanation: cleanText(row.answer_guidance),
          reference_links: parseRefs(row.citations),
          tags: [],
          is_active: cleanText(row.is_active) !== "f",
        });

        if (batch.length >= batchSize) {
          parser.pause();
          upsertBatched("question_bank", batch, "external_id")
            .then((n) => {
              total += n;
              batch = [];
              parser.resume();
            })
            .catch(reject);
        }
      })
      .on("error", reject)
      .on("end", async () => {
        try {
          total += await upsertBatched("question_bank", batch, "external_id");
          resolve();
        } catch (e) {
          reject(e);
        }
      });

    fs.createReadStream(ESSAYS_CSV).pipe(parser);
  });

  console.log(`[essays] done: ${total}`);
  return total;
}

async function importDocumentSections() {
  if (!fileExists(DOC_SECTIONS_CSV)) {
    console.log("[document_sections] not found, skipping");
    return { docs: 0, chunks: 0 };
  }

  console.log("[document_sections] importing", DOC_SECTIONS_CSV);
  const sourceId = await getOrCreateSource(
    "old_self_host",
    "legacy_document_sections_export"
  );

  let docsTotal = 0;
  let chunksTotal = 0;
  let docBatch = [];
  let chunkBatch = [];
  const seenDocs = new Set();
  const docBatchSize = 250;
  const chunkBatchSize = 400;
  let fallbackChunkIndex = 0;

  await new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });

    parser.on("data", async (row) => {
        const documentId =
          cleanText(row.document_id) || `legacy-doc-${cleanText(row.id) || "na"}`;

        if (!seenDocs.has(documentId)) {
          seenDocs.add(documentId);
          docBatch.push({
            source_id: sourceId,
            document_id: documentId,
            title: documentId,
            part: null,
            section: null,
            topic: null,
            metadata: {},
          });
        }

        const parsedChunkIndex = toInt(row.chunk_index, null);
        fallbackChunkIndex += 1;
        const pageNumber = toInt(row.page_number, null);
        const stableChunkId =
          cleanText(row.id) ||
          `${documentId}:${pageNumber ?? "na"}:${parsedChunkIndex ?? fallbackChunkIndex}:${
            cleanText(row.content_hash) || "nohash"
          }`;
        chunkBatch.push({
          legacy_chunk_id: stableChunkId,
          document_id: documentId,
          page_number: pageNumber,
          chunk_index: parsedChunkIndex === null ? fallbackChunkIndex : parsedChunkIndex,
          chunk_type: cleanText(row.chunk_type) || "other",
          question_no: cleanText(row.question_no),
          content: cleanText(row.content) || "",
          tokens: null,
          tags: [],
          metadata: cleanText(row.content_hash) ? { content_hash: row.content_hash } : {},
        });

        const flushDocs = async () => {
          if (!docBatch.length) return;
          docsTotal += await upsertBatched(
            "content_documents",
            docBatch,
            "document_id"
          );
          docBatch = [];
        };

        const flushChunks = async () => {
          if (!chunkBatch.length) return;
          chunksTotal += await upsertBatched(
            "content_chunks",
            chunkBatch,
            "legacy_chunk_id"
          );
          chunkBatch = [];
          if (chunksTotal % 5000 === 0) {
            console.log(`[document_sections] processed chunks ${chunksTotal}`);
          }
        };

        if (docBatch.length >= docBatchSize || chunkBatch.length >= chunkBatchSize) {
          parser.pause();
          Promise.resolve()
            .then(flushDocs)
            .then(flushChunks)
            .then(() => parser.resume())
            .catch(reject);
        }
      })
      .on("error", reject)
      .on("end", async () => {
        try {
          docsTotal += await upsertBatched("content_documents", docBatch, "document_id");
          chunksTotal += await upsertBatched(
            "content_chunks",
            chunkBatch,
            "legacy_chunk_id"
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });

    fs.createReadStream(DOC_SECTIONS_CSV).pipe(parser);
  });

  console.log(`[document_sections] done: docs=${docsTotal}, chunks=${chunksTotal}`);
  return { docs: docsTotal, chunks: chunksTotal };
}

async function main() {
  console.log("Starting legacy content import...");
  console.log("Data dir:", DATA_DIR);

  const mcqCount = await importQuestions();
  const essayCount = await importEssays();
  const rag = await importDocumentSections();

  console.log("Import complete.");
  console.log(
    JSON.stringify(
      {
        question_bank_upserts: mcqCount + essayCount,
        document_upserts: rag.docs,
        chunk_upserts: rag.chunks,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
