import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const OLD_EXAM = "7e48129a-35ae-41a2-9cb8-8bb3f7227578";
const INSTITUTE = "fbfea684-cece-4025-a812-baff14c4a8ba";

async function main() {
  // 1. Create new generic exam
  const { data: exam, error: examErr } = await sb
    .from("mock_exams")
    .insert({
      slug: "cma-p1-practice",
      exam: "cma_p1",
      title: "CMA Part 1 — Practice Exam",
      description:
        "Full CMA Part 1 practice exam: 100 MCQs (3 hours) + 2 essay scenarios (1 hour).",
      total_minutes: 240,
      mcq_minutes: 180,
      essay_minutes: 60,
      mcq_count: 100,
      essay_count: 2,
      difficulty: "exam_grade",
      is_paid: false,
      is_published: true,
      pass_threshold: 360,
      institute_id: INSTITUTE,
      access_mode: "token",
    })
    .select("id")
    .single();

  if (examErr) {
    console.log("EXAM_ERR:", examErr.message);
    return;
  }
  console.log("NEW_EXAM_ID:", exam.id);

  // 2. Get all MCQs from old exam
  const { data: allMcqs } = await sb
    .from("mcq_questions")
    .select("*")
    .eq("exam_id", OLD_EXAM)
    .order("position");

  const byTopic = {};
  allMcqs.forEach((q) => {
    const t = q.topic || "Unknown";
    if (!byTopic[t]) byTopic[t] = [];
    byTopic[t].push(q);
  });

  console.log("TOPICS:");
  Object.entries(byTopic).forEach(([t, qs]) =>
    console.log("  " + t + ": " + qs.length)
  );

  // 3. Select 100 MCQs proportionally
  const quotas = {
    "External Financial Reporting Decisions": 20,
    "Planning, Budgeting and Forecasting": 24,
    "Performance Management": 24,
    "Cost Management": 14,
    "Internal Controls": 18,
  };

  const selected = [];
  let pos = 1;
  for (const [topic, count] of Object.entries(quotas)) {
    const pool = byTopic[topic] || [];
    const shuffled = pool.sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, count);
    picked.forEach((q) => {
      selected.push({
        exam_id: exam.id,
        section_id: q.section_id,
        topic: q.topic,
        stem: q.stem,
        choices: q.choices,
        correct_key: q.correct_key,
        explanation: q.explanation,
        difficulty: q.difficulty,
        position: pos++,
        source_chunk_id: q.source_chunk_id,
        metadata: q.metadata,
      });
    });
  }

  console.log("SELECTED_MCQs:", selected.length);

  // 4. Insert MCQs
  for (let i = 0; i < selected.length; i += 50) {
    const batch = selected.slice(i, i + 50);
    const { error } = await sb.from("mcq_questions").insert(batch);
    if (error) {
      console.log("MCQ_INSERT_ERR at", i, ":", error.message);
      return;
    }
  }
  console.log("MCQs inserted");

  // 5. Insert 2 essay prompts
  const essays = [
    {
      exam_id: exam.id,
      position: 1,
      scenario:
        "Brown Printing is a small printing company that produces hardcover books of local interest. The company has been operating for several years and has accumulated the following cost data for the month of March:\n\nProduction: 5,000 books produced, 4,000 books sold\nSelling price: $50 per book\n\nVariable manufacturing costs per unit:\n- Direct materials: $10\n- Direct labor: $8\n- Variable manufacturing overhead: $7\n\nFixed manufacturing overhead: $80,000 (total for the month)\nVariable selling expenses: $3 per book sold\nFixed selling and administrative expenses: $20,000\n\nThe owners of Brown Printing are trying to understand the differences between costing methods and how they affect reported income.",
      question:
        "Part A: Define absorption costing and variable costing, clearly explaining how each method treats fixed manufacturing overhead.\n\nPart B: Using variable costing, calculate the unit product cost and prepare an income statement for March.\n\nPart C: Using absorption costing, calculate the unit product cost and prepare an income statement for March.\n\nPart D: Discuss two advantages of variable costing for internal decision-making and two limitations of absorption costing.\n\nPart E: Explain why net income differs between the two methods for March. Under what circumstances would the two methods produce the same net income?\n\nPart F: Define throughput costing and explain how it differs from both variable and absorption costing.",
      recommended_minutes: 30,
      metadata: {
        topic: "Cost Management — Costing Methods",
        answer_guidance:
          "Absorption costing treats fixed manufacturing overhead as product cost ($80,000/5,000 = $16/unit); variable costing treats it as period cost. Variable unit cost = $25; absorption unit cost = $41. Variable costing income: Revenue $200,000 - Variable COGS $100,000 - Variable selling $12,000 - Fixed MOH $80,000 - Fixed S&A $20,000 = -$12,000. Absorption costing income: Revenue $200,000 - Absorption COGS $164,000 - Variable selling $12,000 - Fixed S&A $20,000 = $4,000. Difference of $16,000 = 1,000 units in ending inventory x $16 fixed OH per unit. Methods produce same income when production = sales (no inventory change). Throughput costing only treats direct materials as inventoriable cost — even more conservative than variable costing.",
      },
    },
    {
      exam_id: exam.id,
      position: 2,
      scenario:
        "Brawn Technology is a diversified company with a remote manufacturing facility that has recently come under scrutiny. Reports suggest the facility may lack proper permits for disposing of industrial waste, and there are concerns about worker safety conditions not meeting regulatory standards. Several employees have informally reported potential violations to management.\n\nThe president of Brawn Technology is concerned about the company's legal exposure and has requested that the internal audit department conduct a thorough review of the facility. The president also wants to know what additional procedures could be put in place to prevent such issues from arising in the future.",
      question:
        "Part A: Identify and describe the two fundamental types of internal audits. Provide a specific example of each type that would be relevant to a manufacturing company like Brawn Technology.\n\nPart B: Recommend which type of internal audit should be conducted at Brawn Technology's remote facility. Clearly state the audit objectives and explain the reasons for your recommendation.\n\nPart C: Describe two specific audit procedures that could be implemented to address the president's concerns about regulatory compliance at the remote facility.\n\nPart D: Discuss the ethical obligations of the internal audit team when conducting this review, particularly regarding the reporting of potential environmental and safety violations.",
      recommended_minutes: 30,
      metadata: {
        topic: "Internal Controls — Internal Audit & Compliance",
        answer_guidance:
          "Two types: compliance audits (adherence to laws, regulations, policies — e.g., checking environmental permits) and operational audits (evaluating efficiency and effectiveness — e.g., reviewing production processes). For Brawn, compliance audit is appropriate — focused on environmental permits and safety regulations. Objectives: verify proper permits exist, assess safety compliance, identify violations, recommend corrective actions. Procedures: (1) review all environmental permits and licenses for completeness and currency, (2) physical inspection of waste disposal areas and safety equipment, interview employees about safety practices, test compliance with OSHA standards. Ethical obligations: maintain objectivity and independence, report findings accurately regardless of management pressure, maintain confidentiality, follow IIA Code of Ethics, duty to report violations to appropriate authorities if management fails to act.",
      },
    },
  ];

  const { error: essayErr } = await sb.from("essay_prompts").insert(essays);
  if (essayErr) {
    console.log("ESSAY_ERR:", essayErr.message);
    return;
  }
  console.log("Essays inserted");

  // 6. Create access token
  const { data: token, error: tokErr } = await sb
    .from("exam_access_tokens")
    .insert({
      exam_id: exam.id,
      token: "cma-p1-practice-2025",
      label: "Practice Examination",
      is_active: true,
    })
    .select("id, token")
    .single();
  if (tokErr) {
    console.log("TOKEN_ERR:", tokErr.message);
    return;
  }

  console.log("\n=== DONE ===");
  console.log("Exam ID:", exam.id);
  console.log("Token:", token.token);
  console.log("Exam URL: https://costudy.in/exam/" + token.token);
  console.log("Admin URL: https://costudy.in/admin/results/" + token.token);
}

main().catch(console.error);
