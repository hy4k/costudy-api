const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Load env from .env file if running locally — on VPS uses real env
try { require("dotenv").config(); } catch {}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PART2_EXAM_ID = "f0a1b2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5"; // deterministic ID

// CMA Part 2 topic distribution (official weights)
const TOPIC_QUOTAS = {
  "Financial Statement Analysis": 17,  // 20% but only 17 available
  "Corporate Finance": 22,            // fill to reach 100
  "Decision Analysis": 26,            // fill to reach 100
  "Risk Management": 10,              // 10%
  "Investment Decisions": 10,         // 10%
  "Professional Ethics": 15,          // 15%
};
// Total: 17+22+26+10+10+15 = 100

async function main() {
  console.log("=== Setting up CMA Part 2 Practice Exam ===\n");

  // 1. Create Part 2 exam
  console.log("1. Creating Part 2 exam...");
  const { data: existingExam } = await sb
    .from("mock_exams")
    .select("id")
    .eq("id", PART2_EXAM_ID)
    .single();

  if (existingExam) {
    console.log("   Exam already exists, cleaning up old questions...");
    await sb.from("mcq_questions").delete().eq("exam_id", PART2_EXAM_ID);
    await sb.from("essay_prompts").delete().eq("exam_id", PART2_EXAM_ID);
    await sb.from("mock_exams").delete().eq("id", PART2_EXAM_ID);
  }

  const { error: examErr } = await sb.from("mock_exams").insert({
    id: PART2_EXAM_ID,
    title: "CMA Part 2 — Practice Exam",
    slug: "cma-p2-practice",
    exam: "CMA Part 2",
    mcq_count: 100,
    essay_count: 2,
    total_minutes: 240,
    mcq_minutes: 180,
    essay_minutes: 60,
    pass_threshold: 72,
    is_published: true,
  });
  if (examErr) { console.error("Exam insert error:", examErr); return; }
  console.log("   Created exam: CMA Part 2 — Practice Exam");

  // 2. Select 100 MCQs from 144 parsed questions
  console.log("\n2. Selecting 100 MCQs...");
  const allQs = JSON.parse(fs.readFileSync("part2-questions.json", "utf8"));

  const selected = [];
  for (const [topic, quota] of Object.entries(TOPIC_QUOTAS)) {
    const topicQs = allQs.filter((q) => q.topic === topic);
    // Shuffle and take quota
    const shuffled = topicQs.sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, quota);
    console.log(`   ${topic}: ${picked.length}/${topicQs.length} (target ${quota})`);
    selected.push(...picked);
  }

  console.log(`   Total selected: ${selected.length}`);

  // 3. Insert MCQs
  console.log("\n3. Inserting MCQs...");
  const topicToSection = {
    "Financial Statement Analysis": "cma_p2_a",
    "Corporate Finance": "cma_p2_b",
    "Decision Analysis": "cma_p2_c",
    "Risk Management": "cma_p2_d",
    "Investment Decisions": "cma_p2_e",
    "Professional Ethics": "cma_p2_f",
  };

  const mcqRows = selected.map((q, idx) => ({
    exam_id: PART2_EXAM_ID,
    section_id: topicToSection[q.topic],
    position: idx + 1,
    topic: q.topic,
    stem: q.stem,
    choices: q.choices,
    correct_key: q.correct_key,
    explanation: "",
  }));

  // Insert in batches of 50
  for (let i = 0; i < mcqRows.length; i += 50) {
    const batch = mcqRows.slice(i, i + 50);
    const { error } = await sb.from("mcq_questions").insert(batch);
    if (error) { console.error(`   Insert error at batch ${i}:`, error); return; }
  }
  console.log(`   Inserted ${mcqRows.length} MCQs`);

  // 4. Section IDs — already exist in exam_sections table
  console.log("\n4. Using existing Part 2 sections: cma_p2_a, cma_p2_c");

  // 5. Insert 2 Part 2 essay prompts
  console.log("\n5. Inserting Part 2 essay prompts...");

  // Essay 1: Financial Statement Analysis — CCB Enterprises ratio analysis
  const essay1 = {
    exam_id: PART2_EXAM_ID,
    section_id: "cma_p2_a",
    position: 1,
    scenario: `CCB Enterprises is a mid-size manufacturing company with the following financial data for the most recent fiscal year:

Income Statement Data:
- Net Sales: $4,500,000
- Cost of Goods Sold: $2,700,000
- Gross Profit: $1,800,000
- Operating Expenses: $1,080,000
- Operating Income (EBIT): $720,000
- Interest Expense: $180,000
- Income Before Tax: $540,000
- Income Tax (30%): $162,000
- Net Income: $378,000

Balance Sheet Data:
- Current Assets: Cash $150,000, Accounts Receivable $375,000, Inventory $450,000, Total Current Assets $975,000
- Non-Current Assets: Property, Plant & Equipment (net) $2,025,000
- Total Assets: $3,000,000
- Current Liabilities: Accounts Payable $225,000, Accrued Expenses $75,000, Current Portion of Long-Term Debt $100,000, Total Current Liabilities $400,000
- Long-Term Debt: $1,100,000
- Total Liabilities: $1,500,000
- Shareholders' Equity: Common Stock $500,000, Retained Earnings $1,000,000, Total Equity $1,500,000

Industry averages: Times interest earned 5.0x, Return on total assets 15%, Debt ratio 45%, Current ratio 2.8, Quick ratio 1.5.

The board of directors has asked the management accountant to perform a comprehensive ratio analysis.`,
    question: `Part A: Calculate the following ratios for CCB Enterprises: (1) Times Interest Earned, (2) Return on Total Assets, (3) Debt Ratio, (4) Current Ratio, and (5) Quick Ratio. Show all calculations.

Part B: Compare CCB's ratios to the industry averages provided and discuss what each comparison reveals about the company's financial health in terms of profitability, liquidity, and solvency.

Part C: Discuss at least three limitations of using ratio analysis for making financial decisions.`,
    recommended_minutes: 30,
    model_answer: `Part A: Ratio Calculations
1. Times Interest Earned = EBIT / Interest Expense = $720,000 / $180,000 = 4.0x
2. Return on Total Assets = Net Income / Total Assets = $378,000 / $3,000,000 = 12.6%
3. Debt Ratio = Total Liabilities / Total Assets = $1,500,000 / $3,000,000 = 50%
4. Current Ratio = Current Assets / Current Liabilities = $975,000 / $400,000 = 2.44
5. Quick Ratio = (Cash + AR) / Current Liabilities = ($150,000 + $375,000) / $400,000 = 1.31

Part B: Comparison Analysis
- TIE (4.0x vs 5.0x): Below industry average, indicating slightly lower ability to cover interest obligations. The company should monitor its debt service capacity.
- ROA (12.6% vs 15%): Below industry average, suggesting the company is less efficient at generating returns from its asset base. May need to improve asset utilization or profit margins.
- Debt Ratio (50% vs 45%): Higher than industry, indicating more leveraged position. Combined with lower TIE, this raises moderate solvency concerns.
- Current Ratio (2.44 vs 2.8): Slightly below industry average but still adequate for short-term obligations.
- Quick Ratio (1.31 vs 1.5): Below industry, partly due to higher inventory levels. Liquidity is adequate but not as strong as peers.

Overall, CCB shows adequate but below-average performance across profitability, liquidity, and solvency metrics.

Part C: Limitations of Ratio Analysis
1. Historical Data: Ratios are based on past financial data and may not reflect current conditions or future performance.
2. Accounting Policy Differences: Different companies may use different accounting methods (e.g., FIFO vs LIFO, straight-line vs accelerated depreciation), making cross-company comparisons unreliable.
3. Industry Averages: Industry benchmarks may include companies of varying sizes and business models, potentially distorting comparisons.
4. Non-Financial Factors: Ratios do not capture qualitative factors such as management quality, market position, technological advantages, or regulatory environment.
5. Seasonal Variations: Point-in-time balance sheet figures may not represent typical conditions if the company has seasonal fluctuations.`,
    rubric: JSON.stringify({
      bands: { distinction: 85, pass: 70, borderline: 55 },
      weighting: { concepts: 0.4, calculations: 0.4, communication: 0.2 },
      expected_concepts: [
        "Times Interest Earned calculation and interpretation",
        "Return on Total Assets calculation and interpretation",
        "Debt Ratio calculation and interpretation",
        "Current Ratio and Quick Ratio calculation and interpretation",
        "Industry comparison analysis",
        "Limitations of ratio analysis (at least 3)",
      ],
      expected_calculations: [
        "TIE = EBIT / Interest = 720000/180000 = 4.0x",
        "ROA = Net Income / Total Assets = 378000/3000000 = 12.6%",
        "Debt Ratio = Total Liabilities / Total Assets = 1500000/3000000 = 50%",
        "Current Ratio = CA / CL = 975000/400000 = 2.44",
        "Quick Ratio = (Cash + AR) / CL = 525000/400000 = 1.31",
      ],
    }),
  };

  // Essay 2: Decision Analysis — make-or-buy and transfer pricing
  const essay2 = {
    exam_id: PART2_EXAM_ID,
    section_id: "cma_p2_c",
    position: 2,
    scenario: `Precision Components Inc. manufactures automotive parts in two divisions:

Division A (Components Division) produces a specialized brake sensor at the following costs per unit:
- Direct Materials: $18
- Direct Labor: $12
- Variable Manufacturing Overhead: $8
- Fixed Manufacturing Overhead: $15 (based on capacity of 100,000 units)
- Total Manufacturing Cost: $53 per unit

Division A currently produces 80,000 units per year and sells all units externally at $70 per unit. The division has unused capacity of 20,000 units.

Division B (Assembly Division) currently purchases 15,000 identical brake sensors from an external supplier at $65 per unit. Division B uses these sensors in assembling a premium brake system that sells for $250 per unit.

Division B's other costs per brake system (excluding the sensor):
- Direct Materials: $45
- Direct Labor: $35
- Variable Manufacturing Overhead: $20
- Fixed Manufacturing Overhead: $25

Corporate management is considering requiring Division A to supply sensors to Division B through an internal transfer. Division A's manager argues the transfer price should be the external selling price of $70. Division B's manager insists it should be variable cost ($38).`,
    question: `Part A: Determine the relevant costs for a make-or-buy decision from Division B's perspective. Should Division B purchase internally from Division A or continue buying externally at $65? What is the maximum transfer price Division B should accept?

Part B: From Division A's perspective, calculate the minimum transfer price it should accept for the internal transfer of 15,000 units, given that it has excess capacity. How would your answer change if Division A were operating at full capacity?

Part C: Recommend an appropriate transfer price range and discuss how management should resolve the transfer pricing dispute. Include a discussion of how the transfer price affects each division's performance evaluation.`,
    recommended_minutes: 30,
    model_answer: `Part A: Division B's Perspective
Division B currently pays $65 per unit externally. For the make-or-buy decision:
- External purchase cost: $65 × 15,000 = $975,000
- Any transfer price below $65 benefits Division B
- Maximum transfer price Division B should accept: $65 (external supplier price)

At $65 or below, Division B is indifferent or better off buying internally.

Part B: Division A's Perspective
With excess capacity (20,000 units available, only 15,000 needed):
- Minimum transfer price = Variable cost = $18 + $12 + $8 = $38 per unit
- Fixed costs are irrelevant since they will be incurred regardless
- Any price above $38 generates positive contribution margin for Division A

If Division A is at full capacity:
- Minimum transfer price = Variable cost + Opportunity cost
- Opportunity cost = External selling price - Variable cost = $70 - $38 = $32
- Minimum transfer price = $38 + $32 = $70
- At full capacity, Division A would have to forgo external sales, making the minimum price equal to the market price

Part C: Transfer Price Range and Resolution
Acceptable range (with excess capacity): $38 to $65
- Below $38: Division A loses money on each unit
- Above $65: Division B is better off buying externally
- Any price in this range benefits the company overall

Company-wide benefit of internal transfer:
- Current cost: $65 external × 15,000 = $975,000
- Internal variable cost: $38 × 15,000 = $570,000
- Company saves: $405,000 per year

Recommended approach:
1. Negotiated price method: Let divisions negotiate within the $38-$65 range. A midpoint of ~$52 would split the benefit equally.
2. Dual pricing: Credit Division A at market ($70) and charge Division B at variable cost ($38), with corporate absorbing the difference.
3. Market-based with adjustment: Use $65 (external price) minus avoided selling costs.

Impact on performance evaluation:
- Transfer price directly affects each division's reported profit
- Too low a price demotivates Division A's management
- Too high a price makes Division B appear unprofitable
- Goal congruence requires a price that motivates both divisions while maximizing overall company profit`,
    rubric: JSON.stringify({
      bands: { distinction: 85, pass: 70, borderline: 55 },
      weighting: { concepts: 0.4, calculations: 0.35, communication: 0.25 },
      expected_concepts: [
        "Make-or-buy relevant cost analysis",
        "Transfer pricing minimum and maximum bounds",
        "Opportunity cost when at capacity vs excess capacity",
        "Variable vs fixed cost relevance",
        "Goal congruence in transfer pricing",
        "Performance evaluation impact",
      ],
      expected_calculations: [
        "Variable cost per unit = 18 + 12 + 8 = $38",
        "Maximum transfer price for B = external price = $65",
        "Minimum transfer price (excess capacity) = variable cost = $38",
        "Minimum transfer price (full capacity) = $38 + ($70 - $38) = $70",
        "Company savings = ($65 - $38) × 15,000 = $405,000",
        "Acceptable range = $38 to $65",
      ],
    }),
  };

  const { error: e1 } = await sb.from("essay_prompts").insert(essay1);
  if (e1) console.error("   Essay 1 error:", e1);
  else console.log("   Inserted Essay 1: Ratio Analysis");

  const { error: e2 } = await sb.from("essay_prompts").insert(essay2);
  if (e2) console.error("   Essay 2 error:", e2);
  else console.log("   Inserted Essay 2: Transfer Pricing");

  // 6. Create access token
  console.log("\n6. Creating access token...");
  const { data: existingToken } = await sb
    .from("exam_access_tokens")
    .select("id")
    .eq("token", "cma-p2-practice-2025")
    .single();

  if (existingToken) {
    await sb.from("exam_access_tokens").delete().eq("id", existingToken.id);
  }

  const { error: tokenErr } = await sb.from("exam_access_tokens").insert({
    exam_id: PART2_EXAM_ID,
    token: "cma-p2-practice-2025",
    label: "Practice Examination",
    is_active: true,
    max_uses: 999,
  });
  if (tokenErr) console.error("   Token error:", tokenErr);
  else console.log("   Created token: cma-p2-practice-2025");

  // 7. Verify
  console.log("\n7. Verification...");
  const { count: qCount } = await sb
    .from("mcq_questions")
    .select("id", { count: "exact", head: true })
    .eq("exam_id", PART2_EXAM_ID);
  console.log(`   MCQs: ${qCount}`);

  const { count: eCount } = await sb
    .from("essay_prompts")
    .select("id", { count: "exact", head: true })
    .eq("exam_id", PART2_EXAM_ID);
  console.log(`   Essays: ${eCount}`);

  const { data: tok } = await sb
    .from("exam_access_tokens")
    .select("token, is_active")
    .eq("token", "cma-p2-practice-2025")
    .single();
  console.log(`   Token: ${tok?.token} (active: ${tok?.is_active})`);

  console.log("\n=== DONE ===");
  console.log("Part 2 Exam Link: https://costudy.in/exam/cma-p2-practice-2025");
  console.log("Admin Results: https://costudy.in/admin/results/cma-p2-practice-2025");
}

main().catch(console.error);
