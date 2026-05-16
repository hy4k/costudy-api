import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const EXAM_ID = "beb78505-826f-4cc0-aa0e-8647f96b37f5";

async function main() {
  // Check if essays already exist for this exam
  const { data: existing } = await sb
    .from("essay_prompts")
    .select("id, position")
    .eq("exam_id", EXAM_ID);
  console.log("EXISTING_ESSAYS:", existing);

  if (existing && existing.length > 0) {
    console.log("Essays already exist, skipping insert.");
  } else {
    const essay1Rubric = {
      bands: { pass: 70, borderline: 55, distinction: 85 },
      weighting: { concepts: 0.4, calculations: 0.4, communication: 0.2 },
      expected_concepts: [
        { id: "absorption_definition", topic_tag: "costing_systems", description: "Correctly defines absorption costing — all manufacturing costs as product costs" },
        { id: "variable_definition", topic_tag: "costing_systems", description: "Correctly defines variable costing — only variable manufacturing costs as product costs" },
        { id: "fixed_oh_treatment", topic_tag: "costing_systems", description: "Explains fixed MOH is period cost under variable, product cost under absorption" },
        { id: "cvp_advantage", topic_tag: "cost_concepts", description: "Identifies CVP analysis advantage of variable costing" },
        { id: "overproduction_incentive", topic_tag: "cost_concepts", description: "Recognizes absorption costing can incentivize overproduction" },
        { id: "income_difference_explanation", topic_tag: "costing_systems", description: "Explains income difference due to fixed OH in ending inventory" },
        { id: "equal_income_condition", topic_tag: "costing_systems", description: "States methods give same income when production equals sales" },
        { id: "throughput_definition", topic_tag: "costing_systems", description: "Defines throughput costing — only DM as inventoriable cost" },
      ],
      expected_calculations: [
        { id: "variable_unit_cost", label: "Variable Unit Product Cost", formula: "DM + DL + VMOH", topic_tag: "costing_systems", expected_value: "$25" },
        { id: "absorption_unit_cost", label: "Absorption Unit Product Cost", formula: "Variable + (Fixed MOH / Units Produced)", topic_tag: "costing_systems", expected_value: "$41" },
        { id: "variable_net_income", label: "Variable Costing Net Income", formula: "Sales - VCOGS - VSelling - Fixed MOH - Fixed S&A", topic_tag: "costing_systems", expected_value: "-$12,000" },
        { id: "absorption_net_income", label: "Absorption Costing Net Income", formula: "Sales - ACOGS - VSelling - Fixed S&A", topic_tag: "costing_systems", expected_value: "$4,000" },
        { id: "income_difference", label: "Income Difference", formula: "Ending Inv Units × Fixed MOH/unit", topic_tag: "costing_systems", expected_value: "$16,000" },
      ],
    };

    const essay2Rubric = {
      bands: { pass: 70, borderline: 55, distinction: 85 },
      weighting: { concepts: 0.6, calculations: 0.0, communication: 0.4 },
      expected_concepts: [
        { id: "compliance_audit_def", topic_tag: "coso_framework", description: "Defines compliance audit — adherence to laws, regulations, policies" },
        { id: "operational_audit_def", topic_tag: "coso_framework", description: "Defines operational audit — efficiency and effectiveness of operations" },
        { id: "compliance_example", topic_tag: "coso_framework", description: "Provides relevant compliance audit example for manufacturing" },
        { id: "operational_example", topic_tag: "coso_framework", description: "Provides relevant operational audit example for manufacturing" },
        { id: "compliance_recommendation", topic_tag: "coso_framework", description: "Recommends compliance audit with clear justification" },
        { id: "audit_objectives", topic_tag: "coso_framework", description: "States clear audit objectives (permits, safety, legal exposure)" },
        { id: "document_review_procedure", topic_tag: "control_activities", description: "Describes document review/verification procedure" },
        { id: "physical_inspection_procedure", topic_tag: "control_activities", description: "Describes physical inspection and/or employee interview procedure" },
        { id: "objectivity_independence", topic_tag: "fraud_detection", description: "Discusses objectivity and independence of audit team" },
        { id: "duty_to_report", topic_tag: "fraud_detection", description: "Discusses duty to escalate if management fails to act" },
        { id: "iia_ethics", topic_tag: "fraud_detection", description: "References IIA Code of Ethics or professional standards" },
      ],
      expected_calculations: [],
    };

    const essays = [
      {
        exam_id: EXAM_ID,
        section_id: "cma_p1_d",
        position: 1,
        scenario: "Brown Printing is a small printing company that produces hardcover books of local interest. The company has been operating for several years and has accumulated the following cost data for the month of March:\n\nProduction: 5,000 books produced, 4,000 books sold\nSelling price: $50 per book\n\nVariable manufacturing costs per unit:\n- Direct materials: $10\n- Direct labor: $8\n- Variable manufacturing overhead: $7\n\nFixed manufacturing overhead: $80,000 (total for the month)\nVariable selling expenses: $3 per book sold\nFixed selling and administrative expenses: $20,000\n\nThe owners of Brown Printing are trying to understand the differences between costing methods and how they affect reported income.",
        question: "Part A: Define absorption costing and variable costing, clearly explaining how each method treats fixed manufacturing overhead.\n\nPart B: Using variable costing, calculate the unit product cost and prepare an income statement for March.\n\nPart C: Using absorption costing, calculate the unit product cost and prepare an income statement for March.\n\nPart D: Discuss two advantages of variable costing for internal decision-making and two limitations of absorption costing.\n\nPart E: Explain why net income differs between the two methods for March. Under what circumstances would the two methods produce the same net income?\n\nPart F: Define throughput costing and explain how it differs from both variable and absorption costing.",
        recommended_minutes: 30,
        model_answer: "Part A:\nAbsorption costing (full costing) treats ALL manufacturing costs — both variable and fixed — as product (inventoriable) costs. Fixed manufacturing overhead is allocated to each unit produced.\nVariable costing (direct costing) treats only VARIABLE manufacturing costs as product costs. Fixed manufacturing overhead is treated as a period cost and expensed entirely in the period incurred.\n\nPart B — Variable Costing:\nUnit product cost = DM $10 + DL $8 + Variable MOH $7 = $25/unit\n\nVariable Costing Income Statement:\nSales (4,000 × $50) = $200,000\nLess: Variable COGS (4,000 × $25) = ($100,000)\nVariable Manufacturing Margin = $100,000\nLess: Variable Selling (4,000 × $3) = ($12,000)\nContribution Margin = $88,000\nLess: Fixed MOH $80,000 + Fixed S&A $20,000 = ($100,000)\nNet Operating Loss = ($12,000)\n\nPart C — Absorption Costing:\nUnit product cost = $25 + ($80,000 / 5,000) = $25 + $16 = $41/unit\n\nAbsorption Costing Income Statement:\nSales (4,000 × $50) = $200,000\nLess: COGS (4,000 × $41) = ($164,000)\nGross Margin = $36,000\nLess: Variable Selling $12,000 + Fixed S&A $20,000 = ($32,000)\nNet Operating Income = $4,000\n\nPart D:\nAdvantages of Variable Costing:\n1. Better for CVP analysis — separates fixed and variable costs clearly\n2. Prevents profit manipulation through overproduction — income tied to sales, not production\n\nLimitations of Absorption Costing:\n1. Can incentivize overproduction to spread fixed costs, artificially inflating income\n2. Harder to analyze cost behavior for short-term decisions since costs are blended\n\nPart E:\nDifference = $4,000 - (-$12,000) = $16,000\nEquals: 1,000 units in ending inventory × $16 fixed OH/unit = $16,000\nAbsorption defers $16,000 fixed OH in inventory; variable expenses all $80,000 immediately.\nSame income when production = sales (no inventory change).\n\nPart F:\nThroughput costing treats ONLY direct materials as inventoriable. DL and all overhead are period costs. Most conservative approach.",
        rubric: essay1Rubric,
      },
      {
        exam_id: EXAM_ID,
        section_id: "cma_p1_e",
        position: 2,
        scenario: "Brawn Technology is a diversified company with a remote manufacturing facility that has recently come under scrutiny. Reports suggest the facility may lack proper permits for disposing of industrial waste, and there are concerns about worker safety conditions not meeting regulatory standards. Several employees have informally reported potential violations to management.\n\nThe president of Brawn Technology is concerned about the company's legal exposure and has requested that the internal audit department conduct a thorough review of the facility. The president also wants to know what additional procedures could be put in place to prevent such issues from arising in the future.",
        question: "Part A: Identify and describe the two fundamental types of internal audits. Provide a specific example of each type that would be relevant to a manufacturing company like Brawn Technology.\n\nPart B: Recommend which type of internal audit should be conducted at Brawn Technology's remote facility. Clearly state the audit objectives and explain the reasons for your recommendation.\n\nPart C: Describe two specific audit procedures that could be implemented to address the president's concerns about regulatory compliance at the remote facility.\n\nPart D: Discuss the ethical obligations of the internal audit team when conducting this review, particularly regarding the reporting of potential environmental and safety violations.",
        recommended_minutes: 30,
        model_answer: "Part A — Two Types of Internal Audits:\n1. Compliance Audit: Evaluates adherence to laws, regulations, policies, and contractual obligations. Example: Reviewing environmental permits and OSHA safety standards.\n2. Operational Audit: Evaluates efficiency and effectiveness of operations. Example: Analyzing production line efficiency or maintenance scheduling.\n\nPart B — Recommendation:\nCompliance audit. Objectives: verify environmental permits are current, assess waste disposal compliance, evaluate OSHA adherence, identify violations and legal exposure, recommend corrective actions. Reason: issues are regulatory violations, not operational inefficiency.\n\nPart C — Procedures:\n1. Document Review: Obtain and review all permits, licenses, safety certifications, inspection reports. Cross-reference with current regulations.\n2. Physical Inspection and Interviews: On-site inspection of waste disposal areas and safety equipment. Interview employees about practices, training, incident reporting.\n\nPart D — Ethical Obligations:\n1. Objectivity/Independence: Findings must not be influenced by management pressure.\n2. Accurate Reporting: All violations reported completely; cannot downplay findings.\n3. Confidentiality: Protect whistleblower identities while maintaining transparency.\n4. Duty to Escalate: If management fails to act, escalate to board/audit committee per IIA Code of Ethics.\n5. Professional Competence: Ensure adequate knowledge of regulations or engage specialists.",
        rubric: essay2Rubric,
      },
    ];

    const { error: essayErr } = await sb.from("essay_prompts").insert(essays);
    if (essayErr) {
      console.log("ESSAY_ERR:", essayErr.message);
      console.log("ESSAY_ERR_DETAIL:", JSON.stringify(essayErr));

      return;
    }
    console.log("Essays inserted successfully");
  }

  // Check if token already exists
  const { data: existingToken } = await sb
    .from("exam_access_tokens")
    .select("id, token")
    .eq("exam_id", EXAM_ID)
    .eq("token", "cma-p1-practice-2025");

  if (existingToken && existingToken.length > 0) {
    console.log("Token already exists:", existingToken[0].token);
  } else {
    const { data: token, error: tokErr } = await sb
      .from("exam_access_tokens")
      .insert({
        exam_id: EXAM_ID,
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
    console.log("Token created:", token.token);
  }

  console.log("\n=== DONE ===");
  console.log("Exam ID:", EXAM_ID);
  console.log("Candidate URL: https://costudy.in/exam/cma-p1-practice-2025");
  console.log("Admin URL: https://costudy.in/admin/results/cma-p1-practice-2025");
}

main().catch(console.error);
