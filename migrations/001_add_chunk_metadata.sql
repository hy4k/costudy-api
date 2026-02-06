-- ============================================
-- Migration: Add chunk_type and question_no
-- Run this in Supabase SQL Editor
-- ============================================

-- Step 1: Add new columns to document_sections
ALTER TABLE document_sections
ADD COLUMN IF NOT EXISTS chunk_type TEXT DEFAULT 'other',
ADD COLUMN IF NOT EXISTS question_no TEXT;

-- Step 2: Create index for faster filtering by chunk_type
CREATE INDEX IF NOT EXISTS idx_document_sections_chunk_type 
ON document_sections(chunk_type);

-- Step 3: Create composite index for common query patterns
CREATE INDEX IF NOT EXISTS idx_document_sections_doc_chunk_type 
ON document_sections(document_id, chunk_type);

-- Step 4: Update the match_documents function to support filtering
CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 10,
  filter_document_id text DEFAULT NULL,
  filter_chunk_type text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  document_id text,
  content text,
  page_number int,
  chunk_index int,
  chunk_type text,
  question_no text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ds.id,
    ds.document_id,
    ds.content,
    ds.page_number,
    ds.chunk_index,
    ds.chunk_type,
    ds.question_no,
    1 - (ds.embedding <=> query_embedding) AS similarity
  FROM document_sections ds
  WHERE 
    1 - (ds.embedding <=> query_embedding) > match_threshold
    AND (filter_document_id IS NULL OR ds.document_id = filter_document_id)
    AND (filter_chunk_type IS NULL OR ds.chunk_type = filter_chunk_type)
  ORDER BY ds.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Step 5: Grant execute permission
GRANT EXECUTE ON FUNCTION match_documents TO anon, authenticated, service_role;

-- ============================================
-- Optional: Backfill existing chunks
-- This uses regex patterns to classify MCQ content
-- Run this AFTER the columns are added
-- ============================================

-- Classify MCQ Questions (patterns like "1.", "Q1.", "Question 1:", etc.)
UPDATE document_sections
SET chunk_type = 'mcq_question',
    question_no = (regexp_match(content, '^(?:Q\.?|Question\s*)?(\d+)[.\):]'))[1]
WHERE 
  chunk_type = 'other'
  AND content ~ '^(?:Q\.?|Question\s*)?\d+[.\):]\s*[A-Z]';

-- Classify MCQ Answers (patterns with A) B) C) D) options)
UPDATE document_sections
SET chunk_type = 'mcq_answer'
WHERE 
  chunk_type = 'other'
  AND content ~ '^\s*[A-D][.\)]\s+\w';

-- Classify sections that look like answer keys
UPDATE document_sections
SET chunk_type = 'mcq_answer'
WHERE 
  chunk_type = 'other'
  AND (
    content ~* 'answer[:\s]*[A-D]'
    OR content ~* 'correct answer'
    OR content ~* 'solution:'
  );

-- Verify the classification
-- SELECT chunk_type, COUNT(*) FROM document_sections GROUP BY chunk_type;
