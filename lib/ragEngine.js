/**
 * CoStudy RAG engine helpers — embed, retrieve, chat with quota-aware errors.
 */
import crypto from "crypto";

export function sanitizeText(s) {
  return String(s || "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function isNoisyChunk(content) {
  const c = (content || "").toLowerCase();
  if (!c) return true;
  if (c.includes("t.me/") || c.includes("telegram.me") || c.includes("whatsapp")) return true;
  const letters = c.match(/[a-z]/g)?.length || 0;
  const nonLatin = c.match(/[^\x00-\x7F]/g)?.length || 0;
  if (letters < 20 && nonLatin > 80) return true;
  return false;
}

/** Simple LRU string→value cache (for embeddings) */
export function createLruCache(maxSize = 256) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > maxSize) {
        const first = map.keys().next().value;
        map.delete(first);
      }
    },
    size: () => map.size,
  };
}

export function hashKey(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export function classifyOpenAIError(err) {
  const msg = String(err?.message || err || "");
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 429 || /exceeded your current quota|rate limit|insufficient_quota/i.test(msg)) {
    return {
      code: "openai_quota",
      status: 503,
      message:
        "AI provider quota exceeded. Add billing/credits for OPENAI_API_KEY (or set a paid key) and restart the API.",
      details: msg.slice(0, 400),
    };
  }
  if (status === 401 || /invalid api key|incorrect api key/i.test(msg)) {
    return {
      code: "openai_auth",
      status: 503,
      message: "Invalid OPENAI_API_KEY. Check the key on the API host.",
      details: msg.slice(0, 400),
    };
  }
  return {
    code: "openai_error",
    status: 500,
    message: "AI provider error",
    details: msg.slice(0, 400),
  };
}

/**
 * Expand short/anaphoric follow-ups using recent history (server-side, no extra LLM call).
 */
export function expandQuery(message, history = []) {
  const msg = sanitizeText(message);
  if (msg.length >= 40 && !/\b(it|that|they|this|those|these|above|same)\b/i.test(msg)) {
    return msg;
  }
  const lastUser = [...(history || [])]
    .reverse()
    .find((m) => m.role === "user" && sanitizeText(m.content).length > 10);
  if (!lastUser) return msg;
  return `${sanitizeText(lastUser.content).slice(0, 400)} ${msg}`.trim();
}

export function buildContextBlock(hits, maxChars = 10000) {
  let out = "";
  for (const h of hits || []) {
    const piece =
      `[${h.document_id || "doc"} | page ${h.page_number ?? "?"} | chunk ${h.chunk_index ?? "?"}` +
      `${h.chunk_type ? ` | ${h.chunk_type}` : ""}${h.question_no ? ` | Q#${h.question_no}` : ""}]\n` +
      `${sanitizeText(h.content)}\n\n---\n\n`;
    if (out.length + piece.length > maxChars) break;
    out += piece;
  }
  return out.trim();
}

export function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-12).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: sanitizeText(m.content || "").slice(0, 2000),
  }));
}

/** In-process rate limit: max N requests per IP per window */
export function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map();
  return function rateLimit(ip) {
    const now = Date.now();
    const key = ip || "unknown";
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return { ok: false, retryAfterMs: windowMs - (now - bucket.start) };
    }
    return { ok: true };
  };
}

/**
 * Parse rough MCQ items from a text chunk (HOCK / multipass style).
 * Returns array of { stem, choices, correct_key?, question_no?, explanation? }
 */
export function parseMcqFromChunk(content) {
  const text = sanitizeText(content);
  if (!text || text.length < 40) return [];

  const results = [];
  // Split only on clear question starts (avoid chopping "29." mid-number)
  const blocks = text.split(
    /(?=(?:^|\n)\s*(?:\d{1,3}\.\s+(?:Question\b|[A-Z][a-z])|Question\s*(?:ID)?\s*[:#]|Question:\s*\d+))/i
  );

  const candidates = blocks.length > 1 ? blocks : [text];

  for (const block of candidates) {
    const b = block.trim();
    if (b.length < 50) continue;

    const choiceMatches = [...b.matchAll(/(?:^|\n)\s*([A-E])[\.\)]\s+([^\n]+)/g)];
    if (choiceMatches.length < 3) continue;

    const firstChoiceIdx = b.search(/(?:^|\n)\s*[A-E][\.\)]\s+/);
    if (firstChoiceIdx < 8) continue;
    let stem = b.slice(0, firstChoiceIdx).trim();
    stem = stem
      .replace(/^\[doc:[^\]]+\]\s*/gi, "")
      .replace(/^\[page:\d+\]\s*/gi, "")
      .replace(/^\[chunk:\d+\]\s*/gi, "")
      .replace(/Question\s*ID\s*:\s*[^\n]+\n?/i, "")
      .replace(/^\d{1,3}\.\s*/, "")
      .replace(/^Question:\s*\d+\s*/i, "")
      .trim();

    if (stem.length < 15 || stem.length > 2000) continue;

    const choices = [];
    const seen = new Set();
    for (const m of choiceMatches) {
      const key = m[1].toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const t = m[2].trim();
      if (t.length < 1) continue;
      choices.push({ key, text: t.slice(0, 800) });
      if (choices.length >= 5) break;
    }
    if (choices.length < 3) continue;

    const qNoMatch = b.match(/Question\s*ID\s*:\s*([^\n(]+)/i);
    const ansMatch = b.match(/(?:Answer|Correct)\s*[:\-]\s*([A-E])/i);

    results.push({
      stem: stem.slice(0, 2000),
      choices,
      correct_key: ansMatch ? ansMatch[1].toUpperCase() : null,
      question_no: qNoMatch ? qNoMatch[1].trim().slice(0, 80) : null,
      explanation: null,
    });
  }

  return results;
}
