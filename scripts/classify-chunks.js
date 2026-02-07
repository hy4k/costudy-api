/**
 * Chunk Classification Script
 * 
 * Analyzes document_sections content and updates chunk_type field:
 * - mcq_question: Multiple choice questions (A/B/C/D pattern)
 * - mcq_answer: Answer explanations for MCQs
 * - essay: Essay-style content
 * - other: Everything else
 * 
 * Also extracts question_no where possible.
 * 
 * Usage: node scripts/classify-chunks.js [--dry-run] [--limit=1000]
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const BATCH_LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 5000;
const BATCH_SIZE = 100;

/**
 * MCQ Question patterns:
 * - Has A. B. C. D. or a) b) c) d) choices
 * - Contains question mark before choices
 * - Often starts with a number or "Question"
 */
function isMCQQuestion(content) {
  const c = content.toLowerCase();
  
  // Must have multiple choice indicators
  const hasChoices = /\b[a-d]\s*[.)]\s*\w/i.test(content) || 
                     /\b(option|choice)\s*[a-d]/i.test(c);
  
  // Should have question-like content
  const hasQuestion = content.includes('?') || 
                      /\b(which|what|how|when|where|who|why|calculate|determine|identify|select)\b/i.test(c);
  
  // Check for typical MCQ structure (4 options)
  const optionMatches = content.match(/\b[A-D]\s*[.)]/g) || [];
  const hasMultipleOptions = optionMatches.length >= 3;
  
  return (hasChoices || hasMultipleOptions) && hasQuestion;
}

/**
 * MCQ Answer patterns:
 * - Contains "correct answer" or "answer is"
 * - Has explanation with "because", "rationale", "explanation"
 * - References specific choice letter
 */
function isMCQAnswer(content) {
  const c = content.toLowerCase();
  
  // Direct answer indicators
  const hasAnswerIndicator = /\b(correct\s*(answer|choice|option)|answer\s*(is|:)|rationale|explanation\s*for)/i.test(c);
  
  // Choice reference with explanation
  const hasChoiceExplanation = /\b(choice|option)\s*[a-d]\s*(is|was|would be)\s*(correct|incorrect|wrong)/i.test(c);
  
  // Common answer patterns
  const hasAnswerPattern = /\b(the answer is|correct response|right answer)\b/i.test(c);
  
  return hasAnswerIndicator || hasChoiceExplanation || hasAnswerPattern;
}

/**
 * Essay patterns:
 * - Longer form content without MCQ structure
 * - Contains essay keywords
 * - Descriptive/analytical content
 */
function isEssay(content) {
  const c = content.toLowerCase();
  
  // Essay-specific keywords
  const hasEssayKeywords = /\b(discuss|explain in detail|describe|analyze|evaluate|compare and contrast|essay|written response)\b/i.test(c);
  
  // Longer content without MCQ markers
  const isLongForm = content.length > 500 && !isMCQQuestion(content) && !isMCQAnswer(content);
  
  // Has paragraph structure
  const hasParagraphs = (content.match(/\n\n/g) || []).length >= 2;
  
  return hasEssayKeywords || (isLongForm && hasParagraphs);
}

/**
 * Extract question number from content
 * Patterns: Q.1, Q1, Question 1, #1, 1., etc.
 */
function extractQuestionNo(content) {
  const patterns = [
    /\bQ\.?\s*(\d+)/i,              // Q.1 or Q1
    /\bQuestion\s*#?\s*(\d+)/i,     // Question 1 or Question #1
    /^\s*(\d+)\s*[.)]/m,            // 1. or 1) at start of line
    /\bID:\s*\w+\s*(\d+\.\d+)/i,    // ID: CMA 693 3.16
    /\b(\d+\.\d+)\s*\(/,            // 3.16 (Topic:
  ];
  
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return null;
}

/**
 * Classify a single chunk
 */
function classifyChunk(content) {
  if (!content || content.length < 10) {
    return { chunk_type: 'other', question_no: null };
  }
  
  let chunk_type = 'other';
  
  if (isMCQQuestion(content)) {
    chunk_type = 'mcq_question';
  } else if (isMCQAnswer(content)) {
    chunk_type = 'mcq_answer';
  } else if (isEssay(content)) {
    chunk_type = 'essay';
  }
  
  const question_no = extractQuestionNo(content);
  
  return { chunk_type, question_no };
}

/**
 * Process chunks in batches
 */
async function classifyAllChunks() {
  console.log(`\n🔍 CMA Chunk Classification Script`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no updates)' : 'LIVE'}`);
  console.log(`   Limit: ${BATCH_LIMIT} chunks\n`);
  
  let offset = 0;
  let totalProcessed = 0;
  let stats = { mcq_question: 0, mcq_answer: 0, essay: 0, other: 0 };
  
  while (totalProcessed < BATCH_LIMIT) {
    // Fetch batch
    const { data: chunks, error } = await supabase
      .from('document_sections')
      .select('id, content, chunk_type')
      .is('chunk_type', null)  // Only unclassified
      .order('id')
      .range(offset, offset + BATCH_SIZE - 1);
    
    if (error) {
      console.error('Fetch error:', error);
      break;
    }
    
    if (!chunks || chunks.length === 0) {
      console.log('No more unclassified chunks.');
      break;
    }
    
    // Classify each chunk
    const updates = [];
    for (const chunk of chunks) {
      const { chunk_type, question_no } = classifyChunk(chunk.content);
      stats[chunk_type]++;
      
      updates.push({
        id: chunk.id,
        chunk_type,
        question_no,
      });
    }
    
    // Batch update
    if (!DRY_RUN && updates.length > 0) {
      for (const update of updates) {
        const { error: updateError } = await supabase
          .from('document_sections')
          .update({ chunk_type: update.chunk_type, question_no: update.question_no })
          .eq('id', update.id);
        
        if (updateError) {
          console.error(`Update error for id ${update.id}:`, updateError.message);
        }
      }
    }
    
    totalProcessed += chunks.length;
    offset += BATCH_SIZE;
    
    // Progress
    process.stdout.write(`\r   Processed: ${totalProcessed} chunks...`);
  }
  
  console.log(`\n\n📊 Classification Results:`);
  console.log(`   MCQ Questions: ${stats.mcq_question}`);
  console.log(`   MCQ Answers:   ${stats.mcq_answer}`);
  console.log(`   Essays:        ${stats.essay}`);
  console.log(`   Other:         ${stats.other}`);
  console.log(`   ─────────────────`);
  console.log(`   Total:         ${totalProcessed}\n`);
  
  if (DRY_RUN) {
    console.log('⚠️  Dry run complete. No changes made. Remove --dry-run to apply.\n');
  } else {
    console.log('✅ Classification complete!\n');
  }
}

// Run
classifyAllChunks().catch(console.error);
