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

async function extractText(filePath) {
  return (await mammoth.extractRawText({ path: filePath })).value;
}

function isHeader(line) {
  return line.match(/^PART\s+2/i) || line.match(/^SECTION\s+[A-F]/i) ||
    line.match(/ANSWER\s+KEY/i) || line.match(/^P2\s+SEC/i) ||
    Object.values(SECTION_TOPICS).includes(line);
}

// Strategy for letter-prefixed sections: find A. B. C. D. groups
function parseWithLetters(text) {
  const lines = text.split("\n").map(l => l.trim());
  const questions = [];

  // Find all line indices where A. starts
  const aIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^A\.\s/)) aIndices.push(i);
  }

  for (const aIdx of aIndices) {
    // Find B, C, D after A
    let bIdx = -1, cIdx = -1, dIdx = -1;
    for (let j = aIdx + 1; j < Math.min(aIdx + 12, lines.length); j++) {
      if (lines[j].match(/^B\.\s/) && bIdx < 0) bIdx = j;
      else if (lines[j].match(/^C\.\s/) && cIdx < 0 && bIdx >= 0) cIdx = j;
      else if (lines[j].match(/^D\.\s/) && dIdx < 0 && cIdx >= 0) dIdx = j;
    }

    if (bIdx < 0 || cIdx < 0 || dIdx < 0) continue;

    // Stem = all non-empty lines before A., going back until previous D. or start
    const stemLines = [];
    for (let j = aIdx - 1; j >= 0; j--) {
      if (lines[j].match(/^D\.\s/)) break; // hit previous question's D choice
      if (!lines[j] && stemLines.length > 0) {
        // Check if there's more stem above (tables etc)
        let hasMoreStem = false;
        for (let k = j - 1; k >= Math.max(0, j - 3); k--) {
          if (lines[k] && !lines[k].match(/^[A-D]\.\s/) && !isHeader(lines[k])) {
            hasMoreStem = true;
            break;
          }
        }
        if (!hasMoreStem) break;
      }
      if (lines[j] && !isHeader(lines[j])) {
        stemLines.unshift(lines[j]);
      }
    }

    const choices = [
      { key: "A", text: lines[aIdx].replace(/^A\.\s*/, "").trim() },
      { key: "B", text: lines[bIdx].replace(/^B\.\s*/, "").trim() },
      { key: "C", text: lines[cIdx].replace(/^C\.\s*/, "").trim() },
      { key: "D", text: lines[dIdx].replace(/^D\.\s*/, "").trim() },
    ];

    // Multi-line choices: gather continuation lines
    const choiceIndices = [aIdx, bIdx, cIdx, dIdx];
    for (let ci = 0; ci < 4; ci++) {
      const start = choiceIndices[ci] + 1;
      const end = ci < 3 ? choiceIndices[ci + 1] : dIdx + 5;
      for (let j = start; j < Math.min(end, lines.length); j++) {
        if (!lines[j] || lines[j].match(/^[A-D]\.\s/)) break;
        if (isHeader(lines[j])) break;
        choices[ci].text += " " + lines[j];
      }
    }

    const stem = stemLines.join("\n").replace(/^\d+\.\s*/, "").trim();
    if (stem) questions.push({ stem, choices });
  }

  return questions;
}

// Strategy for non-letter sections: question(? or :) then 4 lines
function parseWithoutLetters(text) {
  const lines = text.split("\n").map(l => l.trim());
  const filtered = lines.filter(l => !isHeader(l));
  const questions = [];

  let i = 0;
  while (i < filtered.length) {
    while (i < filtered.length && !filtered[i]) i++;
    if (i >= filtered.length) break;

    // Collect stem until ? or : at end of a line
    const stemLines = [];
    let foundEnd = false;

    while (i < filtered.length) {
      const line = filtered[i];
      if (!line) {
        if (stemLines.length > 0) stemLines.push("");
        i++;
        continue;
      }
      stemLines.push(line);
      i++;
      // Question ends with ? or sometimes with :
      if (line.match(/\?$/) || line.match(/\?\s*$/) ||
          (line.match(/:$/) && !line.match(/^\d/) && stemLines.length > 0)) {
        foundEnd = true;
        break;
      }
    }

    if (!foundEnd) break;

    while (i < filtered.length && !filtered[i]) i++;

    // Collect 4 choices
    const choices = [];
    while (i < filtered.length && choices.length < 4) {
      const line = filtered[i];
      if (!line) { i++; continue; }
      // If line looks like start of new question (ends with ?), stop
      if (line.match(/\?$/) && choices.length > 0) break;

      const lm = line.match(/^([A-D])\.\s*(.*)/);
      if (lm) {
        choices.push({ key: lm[1], text: lm[2].trim() });
      } else {
        choices.push({ key: ["A","B","C","D"][choices.length], text: line });
      }
      i++;
    }

    if (choices.length === 4) {
      const stem = stemLines.join("\n").replace(/^\d+\.\s*/, "").trim();
      questions.push({ stem, choices });
    }
  }

  return questions;
}

function parseAnswers(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l).filter(l => !isHeader(l));
  return lines.map(line => {
    const nm = line.match(/^\d+\.?\s*([A-D])[\.\s]/);
    const lm = line.match(/^([A-D])\.\s/);
    if (nm) return { key: nm[1], text: line };
    if (lm) return { key: lm[1], text: line };
    return { key: null, text: line };
  });
}

function matchAnswer(ans, choices) {
  if (ans.key) return ans.key;
  const at = ans.text.toLowerCase().replace(/\s+/g, " ").trim().replace(/^\d+\.?\s*/, "");
  for (const c of choices) {
    const ct = c.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (ct === at) return c.key;
    if (ct.includes(at) || at.includes(ct)) return c.key;
    if (ct.length > 15 && at.length > 15 && ct.slice(0,20) === at.slice(0,20)) return c.key;
    // Number match
    const an = at.match(/\$?[\d,]+\.?\d*/g);
    const cn = ct.match(/\$?[\d,]+\.?\d*/g);
    if (an?.length === 1 && cn?.length >= 1 && cn.includes(an[0]) && an[0].length > 1) return c.key;
  }
  return null;
}

async function processSection(section) {
  const qFile = fs.readdirSync(QDIR).find(f => f.includes(`SEC ${section}`));
  const aFile = fs.readdirSync(ADIR).find(f => f.includes(`SEC ${section}`));
  if (!qFile || !aFile) return [];

  console.log(`\n=== SECTION ${section}: ${SECTION_TOPICS[section]} ===`);

  const qText = await extractText(path.join(QDIR, qFile));
  const aText = await extractText(path.join(ADIR, aFile));

  // Detect format: count A./B./C./D. lines
  const aLines = qText.split("\n").filter(l => l.trim().match(/^A\.\s/)).length;
  const hasLetters = aLines >= 5;

  let questions;
  if (hasLetters) {
    questions = parseWithLetters(qText);
    console.log(`  Format: letter-prefixed, parsed ${questions.length}`);
  } else {
    questions = parseWithoutLetters(qText);
    console.log(`  Format: plain text, parsed ${questions.length}`);
  }

  const answers = parseAnswers(aText);
  console.log(`  Answers: ${answers.length}`);

  if (questions.length > answers.length) {
    console.log(`  WARNING: More questions than answers! Truncating to ${answers.length}`);
    questions = questions.slice(0, answers.length);
  }

  const result = [];
  let matched = 0, unmatched = 0;

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const ans = answers[idx];
    let ck = ans ? matchAnswer(ans, q.choices) : null;

    if (!ck && ans) {
      unmatched++;
      if (unmatched <= 5) console.error(`  MISS Q${idx+1}: "${ans.text.slice(0,40)}" | ${q.choices.map(c=>c.key+":"+c.text.slice(0,12)).join(" ")}`);
      ck = "A";
    } else if (!ans) {
      ck = "A";
    } else {
      matched++;
    }

    result.push({ topic: SECTION_TOPICS[section], stem: q.stem, choices: q.choices, correct_key: ck, section });
  }

  console.log(`  Result: ${result.length} questions, ${matched} matched, ${unmatched} unmatched`);
  return result;
}

async function main() {
  const all = [];
  for (const s of ["A","B","C","D","E","F"]) {
    all.push(...await processSection(s));
  }

  console.log(`\nTOTAL: ${all.length}`);
  const tc = {};
  all.forEach(q => { tc[q.topic] = (tc[q.topic] || 0) + 1; });
  console.log("Topics:", JSON.stringify(tc, null, 2));

  // Spot-check Q1 per section
  console.log("\n--- Q1 PER SECTION ---");
  for (const s of ["A","B","C","D","E","F"]) {
    const q = all.find(q => q.section === s);
    if (!q) { console.log(`[${s}] NO QUESTIONS`); continue; }
    console.log(`[${s}] ${q.stem.replace(/\n/g,' ').slice(0,80)}... → ${q.correct_key}`);
    console.log(`   ${q.choices.map(c=>c.key+"."+c.text.slice(0,30)).join(" | ")}`);
  }

  fs.writeFileSync("part2-questions.json", JSON.stringify(all, null, 2));
  console.log("\nSaved part2-questions.json");
}

main().catch(console.error);
