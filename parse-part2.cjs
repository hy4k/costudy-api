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
  const r = await mammoth.extractRawText({ path: filePath });
  return r.value;
}

function isHeaderLine(line) {
  return (
    line.match(/^PART\s+2/i) ||
    line.match(/^SECTION\s+[A-F]/i) ||
    line.match(/ANSWER\s+KEY/i) ||
    line.match(/^P2\s+SEC\s+[A-F]/i) ||
    Object.values(SECTION_TOPICS).includes(line)
  );
}

function parseQuestions(text) {
  const questions = [];
  const lines = text.split("\n").map((l) => l.trim());

  const filtered = [];
  for (const line of lines) {
    if (!line) { filtered.push(""); continue; }
    if (isHeaderLine(line)) continue;
    filtered.push(line);
  }

  let i = 0;
  while (i < filtered.length) {
    while (i < filtered.length && !filtered[i]) i++;
    if (i >= filtered.length) break;

    const stemLines = [];
    let foundQuestion = false;

    while (i < filtered.length) {
      const line = filtered[i];
      if (!line) {
        if (stemLines.length > 0) stemLines.push("");
        i++;
        continue;
      }
      stemLines.push(line);
      i++;
      if (line.includes("?")) { foundQuestion = true; break; }
    }

    if (!foundQuestion) break;

    while (i < filtered.length && !filtered[i]) i++;

    const choices = [];
    while (i < filtered.length && choices.length < 4) {
      const line = filtered[i];
      if (!line) { i++; continue; }
      if (line.includes("?") && choices.length > 0 && !line.match(/^[A-D]\.\s/)) break;

      const letterMatch = line.match(/^([A-D])\.\s*(.*)/);
      if (letterMatch) {
        choices.push({ key: letterMatch[1], text: letterMatch[2].trim() });
      } else {
        const keys = ["A", "B", "C", "D"];
        choices.push({ key: keys[choices.length], text: line });
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

function parseAnswerKeys(text) {
  const answers = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l).filter((l) => !isHeaderLine(l));

  for (const line of lines) {
    const numberedLetter = line.match(/^\d+\.?\s*([A-D])[\.\s]/);
    const letterOnly = line.match(/^([A-D])\.\s/);
    if (numberedLetter) {
      answers.push({ key: numberedLetter[1], text: line });
    } else if (letterOnly) {
      answers.push({ key: letterOnly[1], text: line });
    } else {
      answers.push({ key: null, text: line });
    }
  }
  return answers;
}

function matchAnswerToChoice(answer, choices) {
  if (answer.key) return answer.key;

  const ansText = answer.text.toLowerCase().replace(/\s+/g, " ").trim();
  const cleanAns = ansText.replace(/^\d+\.?\s*/, "").replace(/^[a-d]\.?\s*/, "");

  let bestKey = null;
  let bestScore = 0;

  for (const c of choices) {
    const choiceText = c.text.toLowerCase().replace(/\s+/g, " ").trim();

    if (choiceText === cleanAns || choiceText === ansText) return c.key;

    if (choiceText.includes(cleanAns) || cleanAns.includes(choiceText)) {
      const score = Math.min(choiceText.length, cleanAns.length) / Math.max(choiceText.length, cleanAns.length);
      if (score > bestScore) { bestScore = score; bestKey = c.key; }
    }

    const n = Math.min(20, cleanAns.length, choiceText.length);
    if (n > 5 && choiceText.slice(0, n) === cleanAns.slice(0, n)) {
      if (0.4 > bestScore) { bestScore = 0.4; bestKey = c.key; }
    }

    const ansNums = cleanAns.match(/[\d,]+\.?\d*/g);
    const choiceNums = choiceText.match(/[\d,]+\.?\d*/g);
    if (ansNums && choiceNums) {
      const ansNum = ansNums[ansNums.length - 1];
      const choiceNum = choiceNums[choiceNums.length - 1];
      if (ansNum === choiceNum && ansNum.length > 1 && 0.3 > bestScore) {
        bestScore = 0.3; bestKey = c.key;
      }
    }
  }

  return bestKey;
}

async function processSection(section) {
  const qFile = fs.readdirSync(QDIR).find((f) => f.includes(`SEC ${section}`));
  const aFile = fs.readdirSync(ADIR).find((f) => f.includes(`SEC ${section}`));
  if (!qFile || !aFile) { console.error(`Missing files for section ${section}`); return []; }

  console.log(`\n=== SECTION ${section}: ${SECTION_TOPICS[section]} ===`);

  const qText = await extractText(path.join(QDIR, qFile));
  const aText = await extractText(path.join(ADIR, aFile));

  const questions = parseQuestions(qText);
  const answers = parseAnswerKeys(aText);

  console.log(`  Parsed: ${questions.length} questions, ${answers.length} answers`);

  const result = [];
  let unmatched = 0;

  for (let idx = 0; idx < questions.length; idx++) {
    const q = questions[idx];
    const ans = answers[idx];
    let correctKey = null;

    if (ans) {
      correctKey = matchAnswerToChoice(ans, q.choices);
      if (!correctKey) {
        unmatched++;
        console.error(`  UNMATCHED Q${idx + 1}: ans="${ans.text.slice(0, 60)}" choices=${q.choices.map((c) => c.key + ":" + c.text.slice(0, 20)).join("|")}`);
        correctKey = "A";
      }
    } else {
      console.error(`  NO ANSWER for Q${idx + 1}`);
      correctKey = "A";
    }

    result.push({ topic: SECTION_TOPICS[section], stem: q.stem, choices: q.choices, correct_key: correctKey, section: section });
  }

  if (unmatched > 0) console.log(`  ${unmatched} unmatched answers`);
  return result;
}

async function main() {
  const allQuestions = [];
  for (const section of ["A", "B", "C", "D", "E", "F"]) {
    const qs = await processSection(section);
    allQuestions.push(...qs);
  }

  console.log(`\n\nTOTAL Part 2 Questions: ${allQuestions.length}`);
  const topicCounts = {};
  allQuestions.forEach((q) => { topicCounts[q.topic] = (topicCounts[q.topic] || 0) + 1; });
  console.log("Topic breakdown:", JSON.stringify(topicCounts, null, 2));

  console.log("\n--- SAMPLES ---");
  for (const topic of Object.keys(topicCounts)) {
    const q = allQuestions.find((q) => q.topic === topic);
    console.log(`\n[${topic}] Q: ${q.stem.slice(0, 100)}...`);
    q.choices.forEach((c) => console.log(`  ${c.key}. ${c.text.slice(0, 60)}`));
    console.log(`  CORRECT: ${q.correct_key}`);
  }

  fs.writeFileSync("part2-questions.json", JSON.stringify(allQuestions, null, 2));
  console.log("\nWritten to part2-questions.json");
}

main().catch(console.error);
