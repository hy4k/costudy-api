import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ---- config ----
const PORT = Number(process.env.PORT || 8080);
const NODE_ENV = process.env.NODE_ENV || "development";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // 1536 dims
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4.1-mini";

const DEFAULT_MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.75);
const DEFAULT_TOPK = Number(process.env.TOPK || 10);

// ---- required env checks (fail fast) ----
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ---- clients ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

// ---- start ----
app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on http://0.0.0.0:${PORT}`);
});
