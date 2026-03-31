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

const QUESTIONS_CSV = path.join(DATA_DIR, "questions.csv");
const ESSAYS_CSV = path.join(DATA_DIR, "essay_questions.csv");

function clean(v) {
  if (v === undefined || v === null) return "";
  return String(v)
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
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

function normalizePart(raw) {
  const s = clean(raw).toLowerCase();
  if (/part\s*1/i.test(s) || s === "1" || s === "part1") return "Part 1";
  if (/part\s*2/i.test(s) || s === "2" || s === "part2") return "Part 2";
  return clean(raw) || "";
}

function normalizeDifficulty(raw) {
  const s = clean(raw).toUpperCase();
  if (s === "EASY" || s === "E" || s === "LOW") return "EASY";
  if (s === "HARD" || s === "H" || s === "HIGH" || s === "DIFFICULT") return "HARD";
  return "MEDIUM";
}

async function convertQuestions(outStream) {
  if (!fs.existsSync(QUESTIONS_CSV)) {
    console.log(`[convert] questions.csv not found at ${QUESTIONS_CSV}, skipping`);
    return 0;
  }

  let count = 0;
  let skipped = 0;

  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      ltrim: true,
      rtrim: true,
    });

    parser.on("data", (row) => {
      const questionText = clean(row.question_text || row.question || "");
      if (!questionText || questionText.length < 10) {
        skipped++;
        return;
      }

      const qType = clean(row.question_type || "MCQ").toUpperCase();
      const isEssay = qType === "ESSAY";

      const line = [
        isEssay ? "ESSAY" : "MCQ",
        normalizePart(row.part),
        clean(row.section || ""),
        clean(row.syllabus_topic || row.topic || ""),
        questionText,
        isEssay ? "" : clean(row.option_a || ""),
        isEssay ? "" : clean(row.option_b || ""),
        isEssay ? "" : clean(row.option_c || ""),
        isEssay ? "" : clean(row.option_d || ""),
        clean(row.correct_answer || row.answer_key || ""),
        clean(row.explanation || ""),
        normalizeDifficulty(row.difficulty),
        clean(row.topics || row.tags || ""),
        "true",
      ]
        .map(escCsv)
        .join(",");

      outStream.write(line + "\n");
      count++;
    });

    parser.on("error", (e) => {
      console.warn(`[convert] parser error in questions.csv: ${e.message}`);
    });
    parser.on("end", () => {
      console.log(`[convert] questions.csv: wrote=${count}, skipped=${skipped}`);
      resolve(count);
    });

    fs.createReadStream(QUESTIONS_CSV).pipe(parser);
  });
}

async function convertEssays(outStream) {
  if (!fs.existsSync(ESSAYS_CSV)) {
    console.log(`[convert] essay_questions.csv not found at ${ESSAYS_CSV}, skipping`);
    return 0;
  }

  let count = 0;
  let skipped = 0;

  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      ltrim: true,
      rtrim: true,
    });

    parser.on("data", (row) => {
      const scenario = clean(row.scenario || "");
      const tasks = clean(row.tasks || "");
      const questionText = [scenario, tasks].filter(Boolean).join("\n\nRequired:\n");

      if (!questionText || questionText.length < 20) {
        skipped++;
        return;
      }

      const guidance = clean(row.answer_guidance || "");
      const citations = clean(row.citations || "");

      const line = [
        "ESSAY",
        normalizePart(row.part),
        "",
        clean(row.topic || ""),
        questionText,
        "", "", "", "",
        "",
        guidance,
        normalizeDifficulty(row.difficulty),
        clean(row.topic || "").toLowerCase().replace(/\s+&\s+/g, ",").replace(/\s+/g, "-"),
        "true",
      ]
        .map(escCsv)
        .join(",");

      outStream.write(line + "\n");
      count++;
    });

    parser.on("error", (e) => {
      console.warn(`[convert] parser error in essay_questions.csv: ${e.message}`);
    });
    parser.on("end", () => {
      console.log(`[convert] essay_questions.csv: wrote=${count}, skipped=${skipped}`);
      resolve(count);
    });

    fs.createReadStream(ESSAYS_CSV).pipe(parser);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const outPath = path.join(OUT_DIR, `legacy-corpus-${timestamp}.csv`);
  const outStream = createWriteStream(outPath, { flags: "w" });
  outStream.write(HEADER + "\n");

  console.log(`[convert] output: ${outPath}`);

  const mcqCount = await convertQuestions(outStream);
  const essayCount = await convertEssays(outStream);

  outStream.end();

  console.log(`\n=== Conversion Summary ===`);
  console.log(`MCQ questions:   ${mcqCount}`);
  console.log(`Essay questions: ${essayCount}`);
  console.log(`Total records:   ${mcqCount + essayCount}`);
  console.log(`Output file:     ${outPath}`);
  console.log(`\nNext: npm run ingest:staging`);
}

main().catch((e) => {
  console.error("[convert] failed", e);
  process.exit(1);
});
