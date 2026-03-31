import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BATCH = Number(process.env.CORPUS_PUBLISH_BATCH || 200);

function safeText(v) {
  return v == null ? "" : String(v).trim();
}

async function getOrCreateSource() {
  const sourceName = "curated_question_bank_pipeline";
  const { data: existing, error: selErr } = await supabase
    .from("content_sources")
    .select("id")
    .eq("name", sourceName)
    .limit(1);
  if (selErr) throw selErr;
  if (existing?.length) return existing[0].id;

  const { data, error } = await supabase
    .from("content_sources")
    .insert([{ source_kind: "approved_pipeline", name: sourceName }])
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function fetchPending(offset, limit) {
  const { data, error } = await supabase
    .from("ingestion_staging")
    .select("*")
    .eq("status", "APPROVED")
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data || [];
}

async function publishRows(rows, sourceId) {
  if (!rows.length) return 0;

  const questionUpserts = rows.map((r) => ({
    external_id: `stg-${r.id}`,
    part: r.part || "Part 1",
    section: r.section,
    topic: r.topic,
    question_kind: r.question_type,
    difficulty: r.difficulty || "MEDIUM",
    source_kind: "curated_pipeline",
    question_text: r.question_text,
    options: r.options,
    correct_answer: r.answer_key,
    explanation: r.explanation,
    reference_links: [],
    tags: r.tags || [],
    is_active: true,
  }));

  const docsMap = new Map();
  for (const r of rows) {
    const document_id = `staging/${r.source_file}`;
    if (!docsMap.has(document_id)) {
      docsMap.set(document_id, {
        source_id: sourceId,
        document_id,
        title: `Staged Corpus: ${r.source_file}`,
        part: r.part,
        section: r.section,
        topic: r.topic,
        metadata: {},
      });
    }
  }
  const docsUpserts = Array.from(docsMap.values());

  const chunksUpserts = [];
  for (const r of rows) {
    const docId = `staging/${r.source_file}`;
    chunksUpserts.push({
      legacy_chunk_id: `stg:${r.id}:q`,
      document_id: docId,
      page_number: null,
      chunk_index: r.source_row_number * 10 + 1,
      chunk_type: r.question_type === "ESSAY" ? "essay" : "mcq_question",
      question_no: null,
      content: safeText(r.question_text),
      tokens: null,
      tags: r.tags || [],
      metadata: { staging_id: r.id, kind: "question" },
    });

    const answerText = safeText(r.explanation || r.answer_key);
    if (answerText) {
      chunksUpserts.push({
        legacy_chunk_id: `stg:${r.id}:a`,
        document_id: docId,
        page_number: null,
        chunk_index: r.source_row_number * 10 + 2,
        chunk_type: r.question_type === "ESSAY" ? "essay" : "mcq_answer",
        question_no: null,
        content: answerText,
        tokens: null,
        tags: r.tags || [],
        metadata: { staging_id: r.id, kind: "answer" },
      });
    }
  }

  const { error: qErr } = await supabase.from("question_bank").upsert(questionUpserts, {
    onConflict: "external_id",
  });
  if (qErr) throw qErr;

  const { error: dErr } = await supabase.from("content_documents").upsert(docsUpserts, {
    onConflict: "document_id",
  });
  if (dErr) throw dErr;

  const { error: cErr } = await supabase.from("content_chunks").upsert(chunksUpserts, {
    onConflict: "legacy_chunk_id",
  });
  if (cErr) throw cErr;

  const ids = rows.map((r) => r.id);
  const { error: updateErr } = await supabase
    .from("ingestion_staging")
    .update({
      status: "PUBLISHED",
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  if (updateErr) throw updateErr;

  const events = ids.map((id) => ({
    staging_id: id,
    action: "PUBLISH",
    payload: { pipeline: "publish-approved-corpus.js" },
  }));
  await supabase.from("ingestion_review_events").insert(events);

  return rows.length;
}

async function main() {
  const sourceId = await getOrCreateSource();
  let offset = 0;
  let published = 0;

  while (true) {
    const rows = await fetchPending(0, BATCH);
    if (!rows.length) break;
    published += await publishRows(rows, sourceId);
    console.log(`[publish] published=${published}`);
  }

  console.log(`[publish] complete total=${published}`);
}

main().catch((e) => {
  console.error("[publish] failed", e);
  process.exit(1);
});
