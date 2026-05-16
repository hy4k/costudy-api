const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");

const BASE = "C:/Dev/Mock Exam CMA/Elance/PART 2";
const QDIR = path.join(BASE, "Questions");
const ADIR = path.join(BASE, "Answers");

const SECTION_TOPICS = {
  A: "Financial Statement Analysis",
  B: "Corporate Finance",
  C: "Decision Analysis",
  D: "Risk Management",
  E: "Investment Decisions",
  F: "Professional Ethics",
};

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").trim();
}

function isHeaderText(text) {
  const t = text.trim();
  return (
    t.match(/^PART\s+2/i) ||
    t.match(/^SECTION\s+[A-F]/i) ||
    t.match(/ANSWER\s+KEY/i) ||
    t.match(/^P2\s+SEC/i) ||
    Object.values(SECTION_TOPICS).some(topic => t === topic)
  );
}

async function extractParagraphs(filePath) {
  const result = await mammoth.convertToHtml({ path: filePath });
  const html = result.value;
  // Split by paragraph tags
  const pMatches = html.match(/<p[^>]*>(.*?)<\/p>/gs) || [];
  return pMatches
    .map((p) => stripHtml(p))
    .filter((t) => t && !isHeaderText(t));
}

async function processSection(section) {
  const qFile = fs.readdirSync(QDIR).find((f) => f.includes(`SEC ${section}`));
  const aFile = fs.readdirSync(ADIR).find((f) => f.includes(`SEC ${section}`));
  if (!qFile || !aFile) return [];

  console.log(`\n=== SECTION ${section}: ${SECTION_TOPICS[section]} ===`);

  const qParas = await extractParagraphs(path.join(QDIR, qFile));
  const aParas = await extractParagraphs(path.join(ADIR, aFile));

  console.log(`  Paragraphs: ${qParas.length} question-side, ${aParas.length} answer-side`);

  // Build questions: stem paragraphs + 4 choice paragraphs
  // Key insight: each choice is its own paragraph
  // Stem may be one or more paragraphs (tables, multi-line scenarios)
  // After stem, next 4 short paragraphs are choices

  const questions = [];
  let i = 0;

  while (i < qParas.length) {
    // Collect stem paragraphs until we find what looks like start of choices
    const stemParts = [];
    let foundChoiceStart = false;

    while (i < qParas.length) {
      const para = qParas[i];

      // Check if this paragraph looks like first choice
      // Letter-prefixed: "A. text"
      // Or: a short paragraph that's followed by 3 more short paragraphs
      const isLetterChoice = para.match(/^A\.\s/);

      if (isLetterChoice && stemParts.length > 0) {
        foundChoiceStart = true;
        break;
      }

      // Check if this is a non-letter first choice:
      // stem is complete (has ? or :) and this is a short line followed by 3 more short lines
      const lastStem = stemParts[stemParts.length - 1] || "";
      const stemComplete = lastStem.match(/[?:]$/) || lastStem.match(/[?:]\s*$/);

      if (stemComplete && stemParts.length > 0 && !isLetterChoice) {
        // Check next 3 paragraphs — if they're all short-ish, these are choices
        const remaining = qParas.slice(i, i + 4);
        if (remaining.length === 4) {
          const avgLen = remaining.reduce((s, p) => s + p.length, 0) / 4;
          // Choices are typically shorter than stems
          if (avgLen < 200 || remaining.every(p => p.length < 300)) {
            foundChoiceStart = true;
            break;
          }
        }
      }

      stemParts.push(para);
      i++;
    }

    if (!foundChoiceStart) break;

    // Collect 4 choices
    const choices = [];
    for (let c = 0; c < 4 && i < qParas.length; c++) {
      const para = qParas[i];
      const letterMatch = para.match(/^([A-D])\.\s*(.*)/s);
      if (letterMatch) {
        choices.push({ key: letterMatch[1], text: letterMatch[2].trim() });
      } else {
        const keys = ["A", "B", "C", "D"];
        choices.push({ key: keys[c], text: para.trim() });
      }
      i++;
    }

    if (choices.length === 4) {
      const stem = stemParts.join("\n").replace(/^\d+\.\s*/, "").trim();
      questions.push({ stem, choices });
    }
  }

  console.log(`  Questions parsed: ${questions.length}`);

  // Parse answer keys
  const answers = [];
  for (const para of aParas) {
    const numberedLetter = para.match(/^\d+\.?\s*([A-D])[\.\s]/);
    const letterOnly = para.match(/^([A-D])\.\s/);
    if (numberedLetter) {
      answers.push({ key: numberedLetter[1], text: para });
    } else if (letterOnly) {
      answers.push({ key: letterOnly[1], text: para });
    } else {
      answers.push({ key: null, text: para });
    }
  }

  console.log(`  Answers parsed: ${answers.length}`);

  // Match answers to questions
  const result = [];
  let matched = 0;
  let unmatched = 0;

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const ans = answers[idx];
    let correctKey = null;

    if (ans) {
      if (ans.key) {
        correctKey = ans.key;
        matched++;
      } else {
        // Text match
        correctKey = textMatch(ans, q.choices);
        if (correctKey) matched++;
        else {
          unmatched++;
          console.error(`  UNMATCHED Q${idx + 1}: "${ans.text.slice(0, 50)}" vs ${q.choices.map(c=>c.key+":"+c.text.slice(0,15)).join("|")}`);
          correctKey = "A";
        }
      }
    } else {
      console.error(`  NO ANSWER Q${idx + 1}: "${q.stem.slice(0, 60)}"`);
      correctKey = "A";
    }

    result.push({
      topic: SECTION_TOPICS[section],
      stem: q.stem,
      choices: q.choices,
      correct_key: correctKey,
      section: section,
    });
  }

  console.log(`  Matched: ${matched}, Unmatched: ${unmatched}, Missing: ${questions.length - matched - unmatched}`);
  return result;
}

function textMatch(answer, choices) {
  const ansText = answer.text.toLowerCase().replace(/\s+/g, " ").trim();
  const cleanAns = ansText.replace(/^\d+\.?\s*/, "").replace(/^[a-d]\.?\s*/, "");

  for (const c of choices) {
    const ct = c.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (ct === cleanAns || ct === ansText) return c.key;
    if (ct.includes(cleanAns) || cleanAns.includes(ct)) return c.key;
    if (ct.length > 10 && cleanAns.length > 10) {
      const n = Math.min(25, ct.length, cleanAns.length);
      if (ct.slice(0, n) === cleanAns.slice(0, n)) return c.key;
    }
    // Number match
    const ansNums = cleanAns.match(/\$?[\d,]+\.?\d*/g);
    const cNums = ct.match(/\$?[\d,]+\.?\d*/g);
    if (ansNums?.length === 1 && cNums?.length >= 1 && cNums.includes(ansNums[0])) return c.key;
  }
  return null;
}

async function main() {
  const allQuestions = [];
  for (const section of ["A", "B", "C", "D", "E", "F"]) {
    const qs = await processSection(section);
    allQuestions.push(...qs);
  }

  console.log(`\n\nTOTAL: ${allQuestions.length}`);
  const tc = {};
  allQuestions.forEach(q => { tc[q.topic] = (tc[q.topic] || 0) + 1; });
  console.log("Topics:", JSON.stringify(tc, null, 2));

  // Show first Q per section with answer verification
  console.log("\n--- VERIFY FIRST Q PER SECTION ---");
  for (const s of ["A","B","C","D","E","F"]) {
    const q = allQuestions.find(q => q.section === s);
    if (!q) continue;
    console.log(`\n[SEC ${s}] ${q.stem.slice(0, 80)}...`);
    q.choices.forEach(c => console.log(`  ${c.key}. ${c.text.slice(0, 50)}`));
    console.log(`  ANSWER: ${q.correct_key}`);
  }

  fs.writeFileSync("part2-questions.json", JSON.stringify(allQuestions, null, 2));
  console.log("\nSaved part2-questions.json");
}

main().catch(console.error);
