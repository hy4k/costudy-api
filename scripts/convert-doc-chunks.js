import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import path from "path";
import { parse } from "csv-parse";
import { createWriteStream } from "fs";

const DATA_DIR =
  process.env.LEGACY_DATA_DIR ||
  "/root/costudy-frontend/migration-input/old-supabase/data";
const OUT_DIR =
  process.env.CORPUS_OUT_DIR ||
  "/root/costudy-frontend/migration-input/new-corpus";

const SECTIONS_CSV = path.join(DATA_DIR, "document_sections.csv");

function clean(v) {
  if (v === undefined || v === null) return "";
  return String(v)
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMetaPrefix(content) {
  return content
    .replace(/\[doc:[^\]]*\]/gi, "")
    .replace(/\[page:[^\]]*\]/gi, "")
    .replace(/\[chunk:[^\]]*\]/gi, "")
    .trim();
}

function escCsv(v) {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const HEADER = [
  "question_type", "part", "section", "topic",
  "question_text", "option_a", "option_b", "option_c", "option_d",
  "answer_key", "explanation", "difficulty", "tags", "license_ok",
].join(",");

function inferPartFromDoc(docId) {
  if (/\bP1\b|Part\s*1/i.test(docId)) return "Part 1";
  if (/\bP2\b|Part\s*2/i.test(docId)) return "Part 2";
  return "";
}

function inferSectionFromDoc(docId) {
  const m = docId.match(/Section\s+([A-F])/i);
  return m ? `Section ${m[1].toUpperCase()}` : "";
}

function inferUnitTopic(docId) {
  const m = docId.match(/U(\d+)/i);
  return m ? `Unit ${m[1]}` : "";
}

function splitQuestions(text) {
  const results = [];
  const patterns = [
    /(?:^|\s)Question:\s*(\d{1,4})\s+/g,
    /(?:^|\s)Question\s+(\d{1,4})[:\s]+/g,
    /(?:^|\n)\s*(\d{1,4})\.\s+(?=[A-Z])/g,
  ];

  const allStarts = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      allStarts.push({ pos: m.index, num: parseInt(m[1], 10), end: m.index + m[0].length });
    }
  }

  allStarts.sort((a, b) => a.pos - b.pos);

  const deduped = [];
  for (const s of allStarts) {
    if (deduped.length === 0 || s.pos - deduped[deduped.length - 1].pos > 5) {
      deduped.push(s);
    }
  }

  for (let i = 0; i < deduped.length; i++) {
    const bodyStart = deduped[i].end;
    const bodyEnd = i + 1 < deduped.length ? deduped[i + 1].pos : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    if (body.length >= 15) {
      results.push({ num: deduped[i].num, body });
    }
  }

  return results;
}

function extractOptions(body) {
  const options = { A: "", B: "", C: "", D: "" };

  const optRe = /(?:^|\s)([A-Da-d])[\.\)]\s+/g;
  const optStarts = [];
  let m;
  while ((m = optRe.exec(body)) !== null) {
    const letter = m[1].toUpperCase();
    if (letter >= "A" && letter <= "D") {
      optStarts.push({ pos: m.index, letter, end: m.index + m[0].length });
    }
  }

  if (optStarts.length < 2) return { stem: body, options: null };

  let firstA = -1;
  for (let i = 0; i < optStarts.length; i++) {
    if (optStarts[i].letter === "A") {
      const remaining = optStarts.slice(i);
      const hasB = remaining.some((o) => o.letter === "B");
      if (hasB) {
        firstA = i;
        break;
      }
    }
  }

  if (firstA === -1) return { stem: body, options: null };

  const relevantOpts = optStarts.slice(firstA);
  const stem = body.slice(0, relevantOpts[0].pos).trim();

  for (let i = 0; i < relevantOpts.length; i++) {
    const start = relevantOpts[i].end;
    const end = i + 1 < relevantOpts.length ? relevantOpts[i + 1].pos : body.length;
    let text = body.slice(start, end).trim();
    text = text.replace(/\s*(?:Answer|Correct|Explanation)[\s(].*/i, "").trim();
    options[relevantOpts[i].letter] = clean(text);
  }

  const hasAtLeast2 = Object.values(options).filter((v) => v.length > 0).length >= 2;
  if (!hasAtLeast2) return { stem: body, options: null };

  return { stem, options };
}

function extractInlineAnswer(body) {
  const patterns = [
    /Answer\s*\(?([A-Da-d])\)?\s*is\s*correct\b/i,
    /Correct\s*(?:answer|ans)\s*[:\-\s]*\(?([A-Da-d])\)?/i,
    /Answer\s*[:\-\s]*\(?([A-Da-d])\)?(?:\s|$)/i,
    /\(([A-Da-d])\)\s*is\s*(?:the\s+)?correct/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) {
      const key = (m[1] || m[2]).toUpperCase();
      const afterMatch = body.slice(body.indexOf(m[0]) + m[0].length).trim();
      let explanation = "";
      if (afterMatch.length > 10) {
        explanation = clean(afterMatch.replace(/^\.\s*/, "").slice(0, 2000));
      }
      return { key, explanation };
    }
  }
  return null;
}

function parseAnswerChunks(text) {
  const answers = new Map();

  const patterns = [
    /(\d{1,4})\.\s*(?:Correct\s+)?[Aa]nswer\s*[:\-\s]*\(?([A-Da-d])\)?\s*[.\s]*([\s\S]*?)(?=\d{1,4}\.\s*(?:Correct\s+)?[Aa]nswer|$)/g,
    /(?:Question|Q)[\s:]*(\d{1,4})\s*[-–:]\s*(?:Correct\s+)?[Aa]nswer\s*[:\-\s]*\(?([A-Da-d])\)?[.\s]*([\s\S]*?)(?=(?:Question|Q)[\s:]*\d{1,4}|$)/g,
    /Answer\s+(\d{1,4})\s*[:\-\s]*\(?([A-Da-d])\)?[.\s]*([\s\S]*?)(?=Answer\s+\d{1,4}|$)/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const num = parseInt(m[1], 10);
      if (!answers.has(num)) {
        answers.set(num, { key: m[2].toUpperCase(), explanation: clean(m[3]) });
      }
    }
  }

  return answers;
}

async function loadChunks() {
  console.log(`[convert-chunks] reading ${SECTIONS_CSV} ...`);
  const docs = new Map();
  let count = 0;

  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
    });

    parser.on("data", (row) => {
      count++;
      const docId = row.document_id || "";
      const content = stripMetaPrefix(clean(row.content || ""));
      const chunkType = clean(row.chunk_type || "other");
      const page = parseInt(row.page_number || "0", 10);
      const idx = parseInt(row.chunk_index || "0", 10);

      if (!content || content.length < 10) return;

      if (!docs.has(docId)) {
        docs.set(docId, { questions: [], answers: [], essays: [], other: [] });
      }
      const doc = docs.get(docId);
      const chunk = { content, page, idx };

      if (chunkType === "mcq_question") doc.questions.push(chunk);
      else if (chunkType === "mcq_answer") doc.answers.push(chunk);
      else if (chunkType === "essay") doc.essays.push(chunk);
      else doc.other.push(chunk);

      if (count % 5000 === 0) console.log(`[convert-chunks] loaded ${count} chunks...`);
    });

    parser.on("error", () => {});
    parser.on("end", () => {
      console.log(`[convert-chunks] loaded ${count} chunks from ${docs.size} documents`);
      resolve(docs);
    });

    fs.createReadStream(SECTIONS_CSV).pipe(parser);
  });
}

function sortChunks(chunks) {
  return chunks.sort((a, b) => a.page - b.page || a.idx - b.idx);
}

function processDocument(docId, docData) {
  const part = inferPartFromDoc(docId);
  const section = inferSectionFromDoc(docId);
  const topic = inferUnitTopic(docId);
  const records = [];
  const tags = [part, section, topic]
    .filter(Boolean)
    .join(",")
    .toLowerCase()
    .replace(/\s+/g, "-");

  const qText = sortChunks(docData.questions).map((c) => c.content).join(" ");
  const aText = sortChunks(docData.answers).map((c) => c.content).join(" ");
  const otherText = sortChunks(docData.other).map((c) => c.content).join(" ");

  const allAnswers = parseAnswerChunks(aText);
  const otherAnswers = parseAnswerChunks(otherText);
  for (const [k, v] of otherAnswers) {
    if (!allAnswers.has(k)) allAnswers.set(k, v);
  }

  const inlineQAAnswers = parseAnswerChunks(qText);
  for (const [k, v] of inlineQAAnswers) {
    if (!allAnswers.has(k)) allAnswers.set(k, v);
  }

  const allText = [qText, otherText].filter(Boolean).join(" ");
  const rawQuestions = splitQuestions(allText);

  for (const raw of rawQuestions) {
    const { stem, options } = extractOptions(raw.body);
    if (!stem || stem.length < 15) continue;

    let answerKey = "";
    let explanation = "";

    const inline = extractInlineAnswer(raw.body);
    if (inline) {
      answerKey = inline.key;
      explanation = inline.explanation;
    }

    if (!answerKey && allAnswers.has(raw.num)) {
      answerKey = allAnswers.get(raw.num).key;
      explanation = explanation || allAnswers.get(raw.num).explanation;
    } else if (allAnswers.has(raw.num) && !explanation) {
      explanation = allAnswers.get(raw.num).explanation;
    }

    const isMcq = options !== null;
    records.push({
      question_type: isMcq ? "MCQ" : "ESSAY",
      part,
      section,
      topic,
      question_text: clean(stem),
      option_a: options?.A || "",
      option_b: options?.B || "",
      option_c: options?.C || "",
      option_d: options?.D || "",
      answer_key: answerKey,
      explanation,
      difficulty: "MEDIUM",
      tags,
      license_ok: "true",
    });
  }

  for (const chunk of sortChunks(docData.essays)) {
    const essayText = clean(chunk.content);
    if (essayText.length < 30) continue;
    records.push({
      question_type: "ESSAY",
      part, section, topic,
      question_text: essayText,
      option_a: "", option_b: "", option_c: "", option_d: "",
      answer_key: "", explanation: "",
      difficulty: "MEDIUM",
      tags: tags + (tags ? "," : "") + "essay",
      license_ok: "true",
    });
  }

  return records;
}

async function main() {
  const docs = await loadChunks();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const outPath = path.join(OUT_DIR, `chunks-corpus-${timestamp}.csv`);
  const outStream = createWriteStream(outPath, { flags: "w" });
  outStream.write(HEADER + "\n");

  let totalRecords = 0;
  let withAnswer = 0;
  const typeCounts = { MCQ: 0, ESSAY: 0 };

  for (const [docId, docData] of docs) {
    const records = processDocument(docId, docData);
    for (const rec of records) {
      const line = [
        rec.question_type, rec.part, rec.section, rec.topic,
        rec.question_text, rec.option_a, rec.option_b, rec.option_c, rec.option_d,
        rec.answer_key, rec.explanation, rec.difficulty, rec.tags, rec.license_ok,
      ]
        .map(escCsv)
        .join(",");
      outStream.write(line + "\n");
      typeCounts[rec.question_type] = (typeCounts[rec.question_type] || 0) + 1;
      if (rec.answer_key) withAnswer++;
      totalRecords++;
    }
  }

  outStream.end();

  console.log(`\n=== Chunk Conversion Summary ===`);
  console.log(`Documents processed: ${docs.size}`);
  console.log(`MCQ records:         ${typeCounts.MCQ || 0}`);
  console.log(`ESSAY records:       ${typeCounts.ESSAY || 0}`);
  console.log(`With answer keys:    ${withAnswer}`);
  console.log(`Total records:       ${totalRecords}`);
  console.log(`Output file:         ${outPath}`);
}

main().catch((e) => {
  console.error("[convert-chunks] failed", e);
  process.exit(1);
});
