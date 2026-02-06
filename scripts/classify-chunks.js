/**
 * Chunk Classification Utility
 * 
 * This script classifies existing chunks in document_sections
 * into: mcq_question, mcq_answer, essay, other
 * 
 * Run: node scripts/classify-chunks.js
 * 
 * Environment variables required:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Classification patterns
const MCQ_QUESTION_PATTERNS = [
  /^(?:Q\.?|Question\s*)?\d+[.\):]\s*[A-Z]/i,           // "1. What is..." or "Q1. What..."
  /^(?:Q\.?|Question\s*)?#?\d+[.\s]+(?:Which|What|How|Why|When|Where)/i,
  /^\d+\.\s+.+\?/,                                        // "1. ... ?"
  /^(?:MCQ|Multiple Choice)\s*#?\d+/i,
];

const MCQ_ANSWER_PATTERNS = [
  /^\s*[A-D][.\)]\s+\w/,                                  // "A. Something" or "A) Something"
  /(?:correct\s*)?answer[:\s]*[A-D]/i,                    // "Answer: B"
  /^(?:Option\s*)?[A-D][:\s]/i,
  /solution[:\s]/i,
  /^(?:Explanation|Rationale)[:\s]/i,
];

const ESSAY_PATTERNS = [
  /essay\s*(?:question|response|answer)/i,
  /^(?:Essay|Written Response|Short Answer)\s*#?\d*/i,
  /in\s+\d+[-\s]*\d*\s*words/i,                           // "in 150-200 words"
  /discuss\s+(?:in detail|briefly)/i,
  /explain\s+(?:the\s+)?(?:concept|process|importance)/i,
];

function classifyChunk(content) {
  const text = (content || "").trim();
  
  if (!text || text.length < 10) {
    return { chunk_type: "other", question_no: null };
  }

  // Check for MCQ Question
  for (const pattern of MCQ_QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      const match = text.match(/^(?:Q\.?|Question\s*)?#?(\d+)/i);
      return {
        chunk_type: "mcq_question",
        question_no: match ? match[1] : null,
      };
    }
  }

  // Check for MCQ Answer
  for (const pattern of MCQ_ANSWER_PATTERNS) {
    if (pattern.test(text)) {
      // Try to extract question number from context
      const match = text.match(/(?:question|Q)\s*#?(\d+)/i);
      return {
        chunk_type: "mcq_answer",
        question_no: match ? match[1] : null,
      };
    }
  }

  // Check for Essay content
  for (const pattern of ESSAY_PATTERNS) {
    if (pattern.test(text)) {
      return { chunk_type: "essay", question_no: null };
    }
  }

  return { chunk_type: "other", question_no: null };
}

async function classifyAllChunks(batchSize = 500, dryRun = false) {
  console.log(`Starting chunk classification (dryRun: ${dryRun})...`);
  
  let offset = 0;
  let totalProcessed = 0;
  let stats = { mcq_question: 0, mcq_answer: 0, essay: 0, other: 0 };

  while (true) {
    // Fetch batch of unclassified chunks
    const { data: chunks, error } = await supabase
      .from("document_sections")
      .select("id, content, chunk_type")
      .or("chunk_type.is.null,chunk_type.eq.other")
      .range(offset, offset + batchSize - 1);

    if (error) {
      console.error("Fetch error:", error);
      break;
    }

    if (!chunks || chunks.length === 0) {
      console.log("No more chunks to process.");
      break;
    }

    console.log(`Processing batch: ${offset} - ${offset + chunks.length}`);

    const updates = [];
    
    for (const chunk of chunks) {
      const { chunk_type, question_no } = classifyChunk(chunk.content);
      
      if (chunk_type !== "other" || question_no) {
        updates.push({
          id: chunk.id,
          chunk_type,
          question_no,
        });
        stats[chunk_type]++;
      } else {
        stats.other++;
      }
    }

    if (!dryRun && updates.length > 0) {
      // Batch update
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from("document_sections")
          .update({ chunk_type: update.chunk_type, question_no: update.question_no })
          .eq("id", update.id);

        if (updateError) {
          console.error(`Update error for ${update.id}:`, updateError);
        }
      }
      console.log(`  Updated ${updates.length} chunks`);
    } else if (dryRun) {
      console.log(`  Would update ${updates.length} chunks`);
    }

    totalProcessed += chunks.length;
    offset += batchSize;

    // Rate limiting
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\n=== Classification Complete ===");
  console.log(`Total processed: ${totalProcessed}`);
  console.log("Stats:", stats);
}

// Run with --dry-run for testing
const dryRun = process.argv.includes("--dry-run");
classifyAllChunks(500, dryRun).catch(console.error);
