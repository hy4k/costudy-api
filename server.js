import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ---- config ----
const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || "development";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // 1536 dims
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4.1-mini";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";

const DEFAULT_MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.75);
const DEFAULT_TOPK = Number(process.env.TOPK || 10);

// ---- required env checks (fail fast) ----
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!ANTHROPIC_API_KEY) console.warn("⚠️  ANTHROPIC_API_KEY not set — essay grading disabled");

// ---- middleware ----
app.use(express.json({ limit: "2mb" })); // chat requests can be large

// Simple request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// CORS: add domains you will use
const allowedOrigins = [
  "http://localhost:5173",
  "https://costudy.in",
  "https://www.costudy.in",
];

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser tools with no origin
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ---- clients ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const anthropic = ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  : null;

// ---- helpers ----
function sanitizeText(s) {
  // remove nulls + control chars (prevents Supabase text errors + weird PDFs)
  return String(s || "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Basic “noise” filters for your corpus
function isNoisyChunk(content) {
  const c = (content || "").toLowerCase();
  if (!c) return true;
  if (c.includes("t.me/")) return true;
  if (c.includes("telegram.me")) return true;
  if (c.includes("whatsapp")) return true;

  // If a chunk is mostly non-latin, drop it (filters Arabic spam pages)
  // Keep it loose to avoid removing legit math/financial symbols.
  const letters = c.match(/[a-z]/g)?.length || 0;
  const nonLatin = c.match(/[^\x00-\x7F]/g)?.length || 0;
  if (letters < 20 && nonLatin > 80) return true;

  return false;
}

async function embedOne(text) {
  const clean = sanitizeText(text).slice(0, 8000);
  const resp = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: clean,
  });
  return resp.data[0].embedding;
}

async function retrieveContext({ queryEmbedding, topK = DEFAULT_TOPK, threshold = DEFAULT_MATCH_THRESHOLD, filterDoc = null }) {
  // Try calling match_documents with filter_document_id if your function supports it.
  // If not, fallback to calling without it.
  let data, error;

  const payloadWithFilter = {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: topK,
    filter_document_id: filterDoc,
  };

  const payloadNoFilter = {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: topK,
  };

  // Attempt with filter first only if filterDoc is provided
  if (filterDoc) {
    ({ data, error } = await supabase.rpc("match_documents", payloadWithFilter));
    if (error) {
      // If function does not accept filter_document_id, retry without it
      const msg = String(error.message || "");
      if (msg.includes("filter_document_id") || msg.includes("does not exist")) {
        ({ data, error } = await supabase.rpc("match_documents", payloadNoFilter));
      }
    }
  } else {
    ({ data, error } = await supabase.rpc("match_documents", payloadNoFilter));
  }

  if (error) throw error;

  const cleaned = (data || []).filter((r) => !isNoisyChunk(r.content));
  return cleaned;
}

function buildContextBlock(hits, maxChars = 12000) {
  // avoid dumping enormous context to model
  let out = "";
  for (const h of hits) {
    const piece =
      `SOURCE: ${h.document_id} | page:${h.page_number} | chunk:${h.chunk_index}\n` +
      `${sanitizeText(h.content)}\n\n---\n\n`;

    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  return out.trim();
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  // keep last 12 messages, sanitize content
  return history.slice(-12).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: sanitizeText(m.content || "").slice(0, 2000),
  }));
}

function jsonError(res, status, message, details) {
  return res.status(status).json({ ok: false, error: message, details });
}

// ---- routes ----
app.get("/health", (_req, res) => res.json({ ok: true, env: NODE_ENV }));

// Optional: raw vector search endpoint (useful to debug frontend)
app.post("/api/search", async (req, res) => {
  try {
    const { query, topK, threshold, filterDoc } = req.body || {};
    if (!query || typeof query !== "string") return jsonError(res, 400, "query required");

    const qEmbed = await embedOne(query);
    const hits = await retrieveContext({
      queryEmbedding: qEmbed,
      topK: typeof topK === "number" ? topK : DEFAULT_TOPK,
      threshold: typeof threshold === "number" ? threshold : DEFAULT_MATCH_THRESHOLD,
      filterDoc: typeof filterDoc === "string" ? filterDoc : null,
    });

    res.json({
      ok: true,
      hits: hits.map((h) => ({
        document_id: h.document_id,
        page_number: h.page_number,
        chunk_index: h.chunk_index,
        similarity: h.similarity,
        content: h.content,
      })),
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "search error", String(e?.message || e));
  }
});

app.post("/api/ask-cma", async (req, res) => {
  try {
    const { message, subject, mode, history, activeContext, filterDoc } = req.body || {};

    if (!message || typeof message !== "string") {
      return jsonError(res, 400, "message required");
    }

    const userMsg = sanitizeText(message);
    if (userMsg.length < 2) return jsonError(res, 400, "message too short");

    // 1) embed question
    const qEmbed = await embedOne(userMsg);

    // 2) retrieve context
    const hits = await retrieveContext({
      queryEmbedding: qEmbed,
      topK: DEFAULT_TOPK,
      threshold: DEFAULT_MATCH_THRESHOLD,
      filterDoc: typeof filterDoc === "string" ? filterDoc : null,
    });

    const contextBlock = buildContextBlock(hits, 12000);

    const systemLines = [
      "You are a CMA US tutor. Be accurate and exam-focused.",
      "If you use retrieved sources, cite them exactly as: [doc | page | chunk].",
      subject ? `Subject focus: ${sanitizeText(subject).slice(0, 80)}` : "",
      mode === "VAULT_REF" ? "Use the library sources heavily." : "",
      mode === "FOLLOW_UP" && activeContext
        ? `Active study context:\n${sanitizeText(activeContext).slice(0, 2000)}`
        : "",
      "If you are unsure, say so and ask a single clarifying question.",
    ].filter(Boolean);

    const sys = systemLines.join("\n");

    const messages = [
      { role: "system", content: `${sys}\n\nLibrary Context:\n${contextBlock}` },
      ...safeHistory(history),
      { role: "user", content: userMsg.slice(0, 4000) },
    ];

    // 3) chat completion
    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages,
      temperature: 0.3,
    });

    const answer = completion.choices?.[0]?.message?.content || "No answer.";

    res.json({
      ok: true,
      answer,
      sources: hits.map((h) => ({
        document_id: h.document_id,
        page_number: h.page_number,
        chunk_index: h.chunk_index,
        similarity: h.similarity,
      })),
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "AI backend error", String(e?.message || e));
  }
});

app.post("/api/summarize", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") return jsonError(res, 400, "text required");

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: "Summarize into 3-5 crisp bullet points for CMA exam prep." },
        { role: "user", content: sanitizeText(text).slice(0, 12000) },
      ],
      temperature: 0.2,
    });

    res.json({ ok: true, summary: completion.choices?.[0]?.message?.content || "" });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "summarize error", String(e?.message || e));
  }
});

// ---- Standalone exam (token-based, no auth) ----

async function resolveToken(token) {
  const { data, error } = await supabase
    .from("exam_access_tokens")
    .select("*")
    .eq("token", token)
    .eq("is_active", true)
    .single();
  if (error || !data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;
  if (data.max_uses != null && data.used_count >= data.max_uses) return null;
  return data;
}

// Start exam via token
app.post("/api/exam/:token/start", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { guest_name, guest_email } = req.body || {};

    const { data: exam, error: examErr } = await supabase
      .from("mock_exams")
      .select("id, slug, title, total_minutes, mcq_minutes, essay_minutes, mcq_count, essay_count, pass_threshold")
      .eq("id", tok.exam_id)
      .single();
    if (examErr || !exam) return jsonError(res, 404, "exam_not_found");

    // Create attempt
    const { data: attempt, error: attErr } = await supabase
      .from("mock_attempts")
      .insert({
        exam_id: exam.id,
        access_token_id: tok.id,
        guest_name: guest_name || null,
        guest_email: guest_email || null,
        pass_threshold: exam.pass_threshold,
        metadata: { source: "standalone", token: req.params.token },
      })
      .select("id")
      .single();
    if (attErr) return jsonError(res, 500, "attempt_create_failed", attErr.message);

    // Increment used_count
    await supabase
      .from("exam_access_tokens")
      .update({ used_count: tok.used_count + 1 })
      .eq("id", tok.id);

    // Fetch questions (strip correct_key)
    const { data: mcqs } = await supabase
      .from("mcq_questions")
      .select("id, section_id, topic, stem, choices, position, difficulty")
      .eq("exam_id", exam.id)
      .order("position");

    const { data: essays } = await supabase
      .from("essay_prompts")
      .select("id, section_id, position, scenario, question, recommended_minutes")
      .eq("exam_id", exam.id)
      .order("position");

    res.json({
      attempt_id: attempt.id,
      exam: {
        id: exam.id,
        total_minutes: exam.total_minutes,
        mcq_minutes: exam.mcq_minutes || exam.total_minutes,
        essay_minutes: exam.essay_minutes || 0,
        pass_threshold: exam.pass_threshold,
      },
      mcqs: mcqs || [],
      essays: essays || [],
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "start_failed", String(e?.message || e));
  }
});

// Save MCQ answer via token
app.put("/api/exam/:token/attempts/:attemptId/mcq", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;
    const { question_id, selected_key, flagged, time_seconds } = req.body || {};

    // Verify attempt belongs to this token
    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, exam_id, state")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");
    if (att.state !== "in_progress") return jsonError(res, 400, "attempt_not_in_progress");

    // Get correct key
    const { data: q } = await supabase
      .from("mcq_questions")
      .select("correct_key")
      .eq("id", question_id)
      .eq("exam_id", att.exam_id)
      .single();
    if (!q) return jsonError(res, 404, "question_not_found");

    const is_correct = selected_key === q.correct_key;

    // Upsert response
    const { error: upsertErr } = await supabase
      .from("mcq_responses")
      .upsert(
        {
          attempt_id: attemptId,
          question_id,
          selected_key,
          is_correct,
          flagged: flagged || false,
          time_seconds: time_seconds || null,
        },
        { onConflict: "attempt_id,question_id" }
      );
    if (upsertErr) return jsonError(res, 500, "save_failed", upsertErr.message);

    res.json({ ok: true, is_correct });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "mcq_save_failed", String(e?.message || e));
  }
});

// Save essay answer via token
app.post("/api/exam/:token/attempts/:attemptId/essay", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;
    const { prompt_id, content } = req.body || {};

    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, exam_id, state")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");
    if (att.state !== "in_progress") return jsonError(res, 400, "attempt_not_in_progress");

    const { data: sub, error: subErr } = await supabase
      .from("essay_submissions")
      .upsert(
        { attempt_id: attemptId, prompt_id, content, grading_state: "pending" },
        { onConflict: "attempt_id,prompt_id" }
      )
      .select("id, grading_state")
      .single();
    if (subErr) return jsonError(res, 500, "essay_save_failed", subErr.message);

    res.json({ submission_id: sub.id, grading_state: sub.grading_state });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "essay_save_failed", String(e?.message || e));
  }
});

// Finalize attempt via token
app.post("/api/exam/:token/attempts/:attemptId/finalize", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;

    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, exam_id, state")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");
    if (att.state !== "in_progress") return jsonError(res, 400, "already_submitted");

    // Count correct / total
    const { data: responses } = await supabase
      .from("mcq_responses")
      .select("is_correct")
      .eq("attempt_id", attemptId);

    const { data: exam } = await supabase
      .from("mock_exams")
      .select("mcq_count")
      .eq("id", att.exam_id)
      .single();

    const correct = (responses || []).filter((r) => r.is_correct).length;
    const total = exam?.mcq_count || (responses || []).length;
    const mcq_score = total > 0 ? Math.round((correct / total) * 100 * 100) / 100 : 0;

    const now = new Date().toISOString();
    await supabase
      .from("mock_attempts")
      .update({
        state: "completed",
        submitted_at: now,
        completed_at: now,
        mcq_score,
        total_score: mcq_score,
      })
      .eq("id", attemptId);

    res.json({
      state: "completed",
      mcq_score,
      total_score: mcq_score,
      correct,
      total,
      essay_score: null,
      pending_essays: false,
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "finalize_failed", String(e?.message || e));
  }
});

// Validate token (lightweight check)
app.get("/api/exam/:token/validate", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { data: exam } = await supabase
      .from("mock_exams")
      .select("title, mcq_count, essay_count, total_minutes")
      .eq("id", tok.exam_id)
      .single();

    res.json({
      ok: true,
      exam: exam || null,
      label: tok.label,
    });
  } catch (e) {
    return jsonError(res, 500, "validate_failed", String(e?.message || e));
  }
});

// ---- Admin results (token-scoped) ----

// List all attempts for a token
app.get("/api/admin/exam/:token/attempts", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { data: exam } = await supabase
      .from("mock_exams")
      .select("title, mcq_count, essay_count")
      .eq("id", tok.exam_id)
      .single();

    const { data: attempts } = await supabase
      .from("mock_attempts")
      .select("id, state, guest_name, guest_email, mcq_score, total_score, started_at, submitted_at, completed_at")
      .eq("access_token_id", tok.id)
      .order("started_at", { ascending: false });

    res.json({
      ok: true,
      exam: exam || null,
      label: tok.label,
      total_attempts: (attempts || []).length,
      attempts: attempts || [],
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "admin_list_failed", String(e?.message || e));
  }
});

// Get detailed results for a specific attempt
app.get("/api/admin/exam/:token/attempts/:attemptId", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;

    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, state, guest_name, guest_email, mcq_score, total_score, started_at, submitted_at")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");

    // Get MCQ responses with question details
    const { data: responses } = await supabase
      .from("mcq_responses")
      .select("question_id, selected_key, is_correct, flagged, time_seconds")
      .eq("attempt_id", attemptId);

    // Get questions for this exam
    const { data: questions } = await supabase
      .from("mcq_questions")
      .select("id, topic, stem, choices, correct_key, position")
      .eq("exam_id", tok.exam_id)
      .order("position");

    // Get essay submissions
    const { data: essays } = await supabase
      .from("essay_submissions")
      .select("prompt_id, content, grading_state, total_score, concept_score, calc_score, comm_score, performance_band, pass4_aggregate, submitted_at")
      .eq("attempt_id", attemptId);

    // Merge responses into questions
    const responseMap = {};
    (responses || []).forEach((r) => { responseMap[r.question_id] = r; });

    const detailed = (questions || []).map((q) => ({
      position: q.position,
      topic: q.topic,
      stem: q.stem,
      choices: q.choices,
      correct_key: q.correct_key,
      selected_key: responseMap[q.id]?.selected_key || null,
      is_correct: responseMap[q.id]?.is_correct ?? null,
      flagged: responseMap[q.id]?.flagged || false,
    }));

    const correct = detailed.filter((d) => d.is_correct === true).length;
    const answered = detailed.filter((d) => d.selected_key !== null).length;

    res.json({
      ok: true,
      attempt: att,
      summary: { correct, answered, total: detailed.length, mcq_score: att.mcq_score },
      questions: detailed,
      essays: essays || [],
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "admin_detail_failed", String(e?.message || e));
  }
});

// ---- Essay grading ----

async function gradeEssay(submission, prompt) {
  const rubric = prompt.rubric || {};
  const weighting = rubric.weighting || { concepts: 0.5, calculations: 0.3, communication: 0.2 };
  const bands = rubric.bands || { pass: 70, borderline: 55, distinction: 85 };

  const gradingPrompt = `You are a CMA exam essay grader. Grade the student's essay response against the model answer and rubric.

MODEL ANSWER:
${prompt.model_answer}

RUBRIC:
- Expected concepts: ${JSON.stringify(rubric.expected_concepts || [])}
- Expected calculations: ${JSON.stringify(rubric.expected_calculations || [])}
- Weighting: Concepts ${weighting.concepts * 100}%, Calculations ${weighting.calculations * 100}%, Communication ${weighting.communication * 100}%
- Pass: ${bands.pass}%, Borderline: ${bands.borderline}%, Distinction: ${bands.distinction}%

SCENARIO:
${prompt.scenario}

QUESTION:
${prompt.question}

Grade the student response and return a JSON object with:
{
  "concept_score": <0-100 score for conceptual understanding>,
  "calc_score": <0-100 score for calculations accuracy>,
  "comm_score": <0-100 score for communication/presentation>,
  "total_score": <weighted total 0-100>,
  "performance_band": "<distinction|pass|borderline|fail>",
  "feedback": "<2-3 paragraphs of detailed feedback: what was done well, what was missed, specific improvements needed>"
}

Be fair but rigorous. CMA exam standards apply. Return ONLY valid JSON, no markdown.`;

  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY not configured — cannot grade essays");
  }

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    messages: [
      { role: "user", content: `${gradingPrompt}\n\nSTUDENT RESPONSE:\n${submission.content}` },
    ],
    temperature: 0.2,
  });

  const raw = message.content?.[0]?.text || "{}";
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { concept_score: 0, calc_score: 0, comm_score: 0, total_score: 0, performance_band: "fail", feedback: "Grading error. Please contact administrator." };
  }
}

// Admin: trigger grading for all ungraded essays of an attempt
app.post("/api/admin/exam/:token/attempts/:attemptId/grade-essays", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;

    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, exam_id")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");

    const { data: submissions } = await supabase
      .from("essay_submissions")
      .select("id, prompt_id, content, grading_state")
      .eq("attempt_id", attemptId);

    if (!submissions || submissions.length === 0) {
      return res.json({ ok: true, graded: 0, message: "No essays to grade" });
    }

    const results = [];
    for (const sub of submissions) {
      if (sub.grading_state === "graded") {
        results.push({ prompt_id: sub.prompt_id, status: "already_graded" });
        continue;
      }

      // Get prompt with rubric and model_answer
      const { data: prompt } = await supabase
        .from("essay_prompts")
        .select("scenario, question, model_answer, rubric")
        .eq("id", sub.prompt_id)
        .single();

      if (!prompt) {
        results.push({ prompt_id: sub.prompt_id, status: "prompt_not_found" });
        continue;
      }

      await supabase
        .from("essay_submissions")
        .update({ grading_state: "grading" })
        .eq("id", sub.id);

      try {
        const grade = await gradeEssay(sub, prompt);

        await supabase
          .from("essay_submissions")
          .update({
            grading_state: "graded",
            concept_score: grade.concept_score,
            calc_score: grade.calc_score,
            comm_score: grade.comm_score,
            total_score: grade.total_score,
            performance_band: grade.performance_band,
            pass4_aggregate: grade.feedback,
            graded_at: new Date().toISOString(),
          })
          .eq("id", sub.id);

        results.push({ prompt_id: sub.prompt_id, status: "graded", score: grade.total_score, band: grade.performance_band });
      } catch (gradeErr) {
        await supabase
          .from("essay_submissions")
          .update({ grading_state: "failed" })
          .eq("id", sub.id);
        results.push({ prompt_id: sub.prompt_id, status: "failed", error: gradeErr.message });
      }
    }

    // Update attempt total_score with combined MCQ + essay
    const { data: updatedSubs } = await supabase
      .from("essay_submissions")
      .select("total_score")
      .eq("attempt_id", attemptId)
      .eq("grading_state", "graded");

    if (updatedSubs && updatedSubs.length > 0) {
      const essayAvg = updatedSubs.reduce((s, e) => s + (e.total_score || 0), 0) / updatedSubs.length;
      const { data: currentAtt } = await supabase
        .from("mock_attempts")
        .select("mcq_score")
        .eq("id", attemptId)
        .single();

      const mcqScore = currentAtt?.mcq_score || 0;
      // Combined: 75% MCQ + 25% essay (CMA weighting)
      const combined = Math.round((mcqScore * 0.75 + essayAvg * 0.25) * 100) / 100;

      await supabase
        .from("mock_attempts")
        .update({ essay_score: essayAvg, total_score: combined })
        .eq("id", attemptId);
    }

    res.json({ ok: true, graded: results.filter((r) => r.status === "graded").length, results });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "grade_failed", String(e?.message || e));
  }
});

// Candidate result page API (token-based)
app.get("/api/exam/:token/results/:attemptId", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attemptId } = req.params;

    const { data: att } = await supabase
      .from("mock_attempts")
      .select("id, state, guest_name, mcq_score, essay_score, total_score, started_at, submitted_at, pass_threshold")
      .eq("id", attemptId)
      .eq("access_token_id", tok.id)
      .single();
    if (!att) return jsonError(res, 404, "attempt_not_found");

    const { data: exam } = await supabase
      .from("mock_exams")
      .select("title, mcq_count, essay_count")
      .eq("id", tok.exam_id)
      .single();

    // MCQ summary by topic
    const { data: responses } = await supabase
      .from("mcq_responses")
      .select("question_id, is_correct")
      .eq("attempt_id", attemptId);

    const { data: questions } = await supabase
      .from("mcq_questions")
      .select("id, topic")
      .eq("exam_id", tok.exam_id);

    const topicMap = {};
    (questions || []).forEach((q) => { topicMap[q.id] = q.topic; });

    const topicBreakdown = {};
    (responses || []).forEach((r) => {
      const topic = topicMap[r.question_id] || "Unknown";
      if (!topicBreakdown[topic]) topicBreakdown[topic] = { correct: 0, total: 0 };
      topicBreakdown[topic].total++;
      if (r.is_correct) topicBreakdown[topic].correct++;
    });

    // Essay results (graded only)
    const { data: essays } = await supabase
      .from("essay_submissions")
      .select("prompt_id, grading_state, total_score, performance_band, concept_score, calc_score, comm_score, pass4_aggregate")
      .eq("attempt_id", attemptId);

    // Get essay prompt titles
    const { data: prompts } = await supabase
      .from("essay_prompts")
      .select("id, position, scenario")
      .eq("exam_id", tok.exam_id);

    const promptMap = {};
    (prompts || []).forEach((p) => { promptMap[p.id] = p; });

    const essayResults = (essays || []).map((e) => ({
      position: promptMap[e.prompt_id]?.position || 0,
      scenario_preview: (promptMap[e.prompt_id]?.scenario || "").slice(0, 100) + "...",
      grading_state: e.grading_state,
      total_score: e.total_score,
      performance_band: e.performance_band,
      concept_score: e.concept_score,
      calc_score: e.calc_score,
      comm_score: e.comm_score,
      feedback: e.pass4_aggregate,
    }));

    const correct = (responses || []).filter((r) => r.is_correct).length;
    const total = (responses || []).length;

    res.json({
      ok: true,
      exam_title: exam?.title || "Exam",
      candidate_name: att.guest_name,
      state: att.state,
      mcq_score: att.mcq_score,
      essay_score: att.essay_score,
      total_score: att.total_score,
      pass_threshold: att.pass_threshold,
      mcq_summary: { correct, total, percentage: att.mcq_score },
      topic_breakdown: topicBreakdown,
      essays: essayResults,
      started_at: att.started_at,
      submitted_at: att.submitted_at,
    });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "results_failed", String(e?.message || e));
  }
});

// Admin: delete specific attempts and all related data
app.post("/api/admin/exam/:token/delete-attempts", async (req, res) => {
  try {
    const tok = await resolveToken(req.params.token);
    if (!tok) return jsonError(res, 403, "invalid_or_expired_token");

    const { attempt_ids } = req.body;
    if (!Array.isArray(attempt_ids) || attempt_ids.length === 0) {
      return jsonError(res, 400, "attempt_ids_required");
    }

    // Verify all attempts belong to this token
    const { data: attempts } = await supabase
      .from("mock_attempts")
      .select("id")
      .eq("access_token_id", tok.id)
      .in("id", attempt_ids);

    const validIds = (attempts || []).map((a) => a.id);
    if (validIds.length === 0) return jsonError(res, 404, "no_valid_attempts");

    // Delete in order: essay_submissions → mcq_responses → mock_attempts
    await supabase.from("essay_submissions").delete().in("attempt_id", validIds);
    await supabase.from("mcq_responses").delete().in("attempt_id", validIds);
    await supabase.from("mock_attempts").delete().in("id", validIds);

    // Decrement used_count on token
    await supabase
      .from("exam_access_tokens")
      .update({ used_count: Math.max(0, (tok.used_count || 0) - validIds.length) })
      .eq("id", tok.id);

    res.json({ ok: true, deleted: validIds.length });
  } catch (e) {
    console.error(e);
    return jsonError(res, 500, "delete_failed", String(e?.message || e));
  }
});

// ---- start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
