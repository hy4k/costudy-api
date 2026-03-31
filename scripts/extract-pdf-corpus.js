import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createWriteStream } from "fs";

const RAW_DIR =
  process.env.PDF_RAW_DIR ||
  "/root/costudy-frontend/migration-input/new-corpus/raw-pdfs";
const OUT_DIR =
  process.env.PDF_OUT_DIR ||
  "/root/costudy-frontend/migration-input/new-corpus";
const REVIEW_DIR = path.join(OUT_DIR, "review-needed-pages");

const MIN_TEXT_CHARS_PER_PAGE = 80;
const OCR_CONFIDENCE_THRESHOLD = 60;
const MAX_PDF_SIZE_MB = Number(process.env.PDF_MAX_SIZE_MB || 50);

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "review-needed" || entry.name === "ESSAY" || entry.name === "already-ingested" || entry.name === "review-needed-pages") continue;
      results.push(...walkDir(full));
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results;
}

function inferPartFromPath(filePath, rawDir) {
  const rel = path.relative(rawDir, filePath).toUpperCase();
  if (/PART.?0?1/.test(rel)) return "Part 1";
  if (/PART.?0?2/.test(rel)) return "Part 2";
  return "";
}

function inferSectionFromPath(filePath) {
  const rel = filePath.toUpperCase();
  const secMatch = rel.match(/SEC(?:TION)?\s*([A-F])/);
  if (secMatch) return `Section ${secMatch[1]}`;
  return "";
}

function extractFullText(pdfPath) {
  try {
    return execFileSync("pdftotext", ["-layout", pdfPath, "-"], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString("utf-8");
  } catch (e) {
    console.warn(`[extract] pdftotext failed: ${e.message}`);
    return null;
  }
}

function getPageCount(pdfPath) {
  try {
    const info = execFileSync("pdfinfo", [pdfPath], {
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString("utf-8");
    const m = info.match(/Pages:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function extractSinglePage(pdfPath, pageNum) {
  try {
    return execFileSync(
      "pdftotext",
      ["-f", String(pageNum), "-l", String(pageNum), "-layout", pdfPath, "-"],
      { maxBuffer: 5 * 1024 * 1024, timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] }
    ).toString("utf-8");
  } catch {
    return "";
  }
}

function ocrPage(pdfPath, pageNum) {
  const tmpBase = `/tmp/costudy_ocr_${process.pid}_p${pageNum}`;
  const tmpImg = `${tmpBase}.png`;
  try {
    execFileSync(
      "pdftoppm",
      ["-f", String(pageNum), "-l", String(pageNum), "-r", "300", "-png", "-singlefile", pdfPath, tmpBase],
      { timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] }
    );
    if (!fs.existsSync(tmpImg)) return { text: "", confidence: 0 };

    const ocrOut = execFileSync("tesseract", [tmpImg, "stdout", "--oem", "1", "-l", "eng"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString("utf-8");

    const confidence = estimateOcrConfidence(ocrOut);
    return { text: ocrOut.trim(), confidence };
  } catch (e) {
    return { text: "", confidence: 0 };
  } finally {
    try { fs.unlinkSync(tmpImg); } catch {}
  }
}

function estimateOcrConfidence(text) {
  if (!text || text.length < 20) return 0;
  const total = text.length;
  const good = (text.match(/[a-zA-Z0-9\s.,;:()\-/?%$'"&]/g) || []).length;
  return Math.round((good / total) * 100);
}

function splitQuestions(text) {
  const results = [];
  const re = /(?:^|\n)\s*(?:(?:Question:?\s*)?(\d{1,4})[\.\)\:])\s+/g;
  const starts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    starts.push({ pos: m.index, num: parseInt(m[1], 10), end: m.index + m[0].length });
  }
  for (let i = 0; i < starts.length; i++) {
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].pos : text.length;
    const body = text.slice(starts[i].end, bodyEnd).trim();
    if (body.length >= 15) results.push({ num: starts[i].num, body });
  }
  return results;
}

function extractOptions(body) {
  const options = { A: "", B: "", C: "", D: "" };
  const re = /(?:^|\n)\s*([A-Da-d])[\.\)]\s+/g;
  const hits = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    hits.push({ pos: m.index, letter: m[1].toUpperCase(), end: m.index + m[0].length });
  }

  let firstA = -1;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].letter === "A" && hits.slice(i).some((h) => h.letter === "B")) {
      firstA = i;
      break;
    }
  }
  if (firstA === -1) return { stem: body, options: null };

  const rel = hits.slice(firstA);
  const stem = body.slice(0, rel[0].pos).trim();
  for (let i = 0; i < rel.length; i++) {
    const start = rel[i].end;
    const end = i + 1 < rel.length ? rel[i + 1].pos : body.length;
    let t = body.slice(start, end).trim();
    t = t.replace(/\s*(?:Answer|Correct|Explanation)[\s(].*/i, "").trim();
    options[rel[i].letter] = t.replace(/\s+/g, " ");
  }
  const count = Object.values(options).filter((v) => v).length;
  if (count < 2) return { stem: body, options: null };
  return { stem, options };
}

function extractAnswer(body) {
  const patterns = [
    /Answer\s*\(?([A-Da-d])\)?\s*is\s*correct/i,
    /Correct\s*(?:answer|ans)\s*[:\-\s]*\(?([A-Da-d])\)?/i,
    /Answer\s*[:\-\s]*\(?([A-Da-d])\)?(?:\s|$|\.|,)/i,
    /\(([A-Da-d])\)\s*is\s*(?:the\s+)?correct/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) {
      const key = m[1].toUpperCase();
      const after = body.slice(body.indexOf(m[0]) + m[0].length).trim();
      return { key, explanation: after.length > 10 ? after.replace(/\s+/g, " ").slice(0, 2000) : "" };
    }
  }
  return null;
}

function escCsv(v) {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_HEADER = [
  "question_type", "part", "section", "topic",
  "question_text", "option_a", "option_b", "option_c", "option_d",
  "answer_key", "explanation", "difficulty", "tags", "license_ok",
].join(",");

function inferTopicFromText(text) {
  const hints = [
    [/budget/i, "Budgeting"], [/cost.?volume.?profit|cvp|break.?even/i, "CVP Analysis"],
    [/variance/i, "Variance Analysis"], [/balance\s+sheet|financial\s+statement/i, "Financial Statements"],
    [/ratio\s+analysis|liquidity|solvency/i, "Financial Ratios"], [/capital\s+budget|npv|irr|payback/i, "Capital Budgeting"],
    [/transfer\s+pric/i, "Transfer Pricing"], [/cost\s+allocation|overhead/i, "Cost Allocation"],
    [/activity.?based/i, "Activity-Based Costing"], [/standard\s+cost/i, "Standard Costing"],
    [/cash\s+flow/i, "Cash Flow"], [/internal\s+control|risk\s+management|coso/i, "Internal Controls"],
    [/ethics|professional\s+responsibility/i, "Ethics"], [/inventory|eoq|fifo|lifo/i, "Inventory Management"],
    [/regression|forecast/i, "Forecasting"], [/bond|interest\s+rate|debt/i, "Financial Instruments"],
    [/merger|acquisition/i, "M&A"], [/working\s+capital/i, "Working Capital"],
    [/performance\s+measure|balanced\s+scorecard|roi|eva/i, "Performance Measurement"],
    [/tax|income\s+tax/i, "Taxation"], [/foreign\s+exchange|fx|currency/i, "Foreign Exchange"],
    [/decision\s+analysis|relevant\s+cost|make.?or.?buy/i, "Decision Analysis"],
    [/pricing|target\s+cost/i, "Pricing Strategy"], [/depreciation|amortization/i, "Depreciation"],
    [/lease|right.?of.?use/i, "Leases"], [/consolidat/i, "Consolidation"],
  ];
  for (const [re, topic] of hints) {
    if (re.test(text)) return topic;
  }
  return "";
}

function inferDifficulty(text) {
  const wc = text.split(/\s+/).length;
  const calc = /\$|%|\d{3,}|calculate|compute|determine\s+the\s+amount/i.test(text);
  const scenario = /scenario|exhibit|following\s+data|information\s+below/i.test(text);
  if (wc > 120 || (calc && scenario)) return "HARD";
  if (wc > 50 || calc || scenario) return "MEDIUM";
  return "EASY";
}

function processPdf(pdfPath, rawDir, csvStream, reviewStream, stats) {
  const relPath = path.relative(rawDir, pdfPath);
  const part = inferPartFromPath(pdfPath, rawDir);
  const section = inferSectionFromPath(relPath);
  console.log(`[extract] ${relPath}`);

  const fullText = extractFullText(pdfPath);
  if (!fullText || fullText.trim().length < 50) {
    const pageCount = getPageCount(pdfPath);
    if (pageCount > 0) {
      let ocrText = "";
      const pagesToOcr = Math.min(pageCount, 5);
      for (let p = 1; p <= pagesToOcr; p++) {
        const ocr = ocrPage(pdfPath, p);
        stats.ocrPages++;
        if (ocr.confidence < OCR_CONFIDENCE_THRESHOLD) {
          reviewStream.write(`${relPath}\tpage=${p}\tconf=${ocr.confidence}\tocr_len=${ocr.text.length}\n`);
          stats.reviewPages++;
        }
        ocrText += ocr.text + "\n\n";
      }
      if (ocrText.trim().length < 50) {
        stats.failedFiles++;
        return;
      }
    } else {
      stats.failedFiles++;
      return;
    }
  }

  const text = fullText || "";
  stats.totalPages += getPageCount(pdfPath) || 1;

  const questions = splitQuestions(text);

  if (!questions.length) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length > 100) {
      csvStream.write(
        [
          "ESSAY", part, section, inferTopicFromText(trimmed),
          escCsv(trimmed.slice(0, 10000)), "", "", "", "",
          "", "", "MEDIUM",
          [part, section].filter(Boolean).join(",").toLowerCase().replace(/\s+/g, "-"),
          "true",
        ].join(",") + "\n"
      );
      stats.records++;
    }
    return;
  }

  for (const q of questions) {
    const { stem, options } = extractOptions(q.body);
    if (!stem || stem.length < 15) { stats.skippedShort++; continue; }

    let answerKey = "";
    let explanation = "";
    const ans = extractAnswer(q.body);
    if (ans) { answerKey = ans.key; explanation = ans.explanation; }

    const topic = inferTopicFromText(stem + " " + explanation);
    const difficulty = inferDifficulty(stem);
    const tags = [part, section, topic]
      .filter(Boolean)
      .join(",")
      .toLowerCase()
      .replace(/\s+/g, "-");

    const line = [
      options ? "MCQ" : "ESSAY", part, section, topic,
      stem, options?.A || "", options?.B || "", options?.C || "", options?.D || "",
      answerKey, explanation, difficulty, tags, "true",
    ].map(escCsv).join(",");

    csvStream.write(line + "\n");
    stats.records++;
  }
}

async function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`[extract] raw PDF directory not found: ${RAW_DIR}`);
    process.exit(1);
  }

  const pdfs = walkDir(RAW_DIR);
  if (!pdfs.length) {
    console.error(`[extract] no PDF files found in ${RAW_DIR}`);
    process.exit(1);
  }

  fs.mkdirSync(REVIEW_DIR, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
  const csvPath = path.join(OUT_DIR, `extracted-corpus-${timestamp}.csv`);
  const reviewPath = path.join(REVIEW_DIR, `low-confidence-pages-${timestamp}.tsv`);

  const csvStream = createWriteStream(csvPath, { flags: "w" });
  csvStream.write(CSV_HEADER + "\n");

  const reviewStream = createWriteStream(reviewPath, { flags: "w" });
  reviewStream.write("file\tpage_info\tconfidence\tocr_text_len\n");

  const stats = {
    totalFiles: pdfs.length, failedFiles: 0, totalPages: 0,
    ocrPages: 0, reviewPages: 0, records: 0, skippedShort: 0,
  };

  console.log(`[extract] found ${pdfs.length} PDFs in ${RAW_DIR}`);

  for (const pdf of pdfs) {
    const sizeMb = fs.statSync(pdf).size / (1024 * 1024);
    if (sizeMb > MAX_PDF_SIZE_MB) {
      console.log(`[extract] SKIP (${sizeMb.toFixed(0)}MB > ${MAX_PDF_SIZE_MB}MB limit): ${path.relative(RAW_DIR, pdf)}`);
      stats.failedFiles++;
      continue;
    }
    try {
      processPdf(pdf, RAW_DIR, csvStream, reviewStream, stats);
    } catch (e) {
      console.error(`[extract] error: ${pdf}: ${e.message}`);
      stats.failedFiles++;
    }
  }

  csvStream.end();
  reviewStream.end();

  console.log("\n=== Extraction Summary ===");
  console.log(`Files processed:   ${stats.totalFiles - stats.failedFiles}/${stats.totalFiles}`);
  console.log(`Pages total:       ${stats.totalPages}`);
  console.log(`Pages OCR'd:       ${stats.ocrPages}`);
  console.log(`Low-conf pages:    ${stats.reviewPages} (flagged for review)`);
  console.log(`Records extracted: ${stats.records}`);
  console.log(`Records skipped:   ${stats.skippedShort} (too short)`);
  console.log(`\nOutput CSV:  ${csvPath}`);
  console.log(`Review log:  ${reviewPath}`);
}

main().catch((e) => {
  console.error("[extract] fatal:", e);
  process.exit(1);
});
