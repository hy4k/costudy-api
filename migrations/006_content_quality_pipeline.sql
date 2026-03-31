-- =============================================
-- CoStudy Content Quality Pipeline (Phase 2)
-- =============================================

CREATE TABLE IF NOT EXISTS ingestion_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file TEXT NOT NULL,
  source_row_number INT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'uploaded_corpus',
  part TEXT,
  section TEXT,
  topic TEXT,
  question_type TEXT NOT NULL CHECK (question_type IN ('MCQ', 'ESSAY')),
  question_text TEXT NOT NULL,
  options JSONB,
  answer_key TEXT,
  explanation TEXT,
  difficulty TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  license_ok BOOLEAN NOT NULL DEFAULT FALSE,
  normalized_hash TEXT NOT NULL,
  quality_score INT NOT NULL DEFAULT 0 CHECK (quality_score >= 0 AND quality_score <= 100),
  quality_bucket TEXT NOT NULL DEFAULT 'REJECT' CHECK (quality_bucket IN ('APPROVE', 'REVIEW', 'REJECT')),
  quality_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED')),
  reviewer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewer_notes TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(normalized_hash)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_staging_status ON ingestion_staging(status, quality_bucket);
CREATE INDEX IF NOT EXISTS idx_ingestion_staging_source ON ingestion_staging(source_file, source_row_number);
CREATE INDEX IF NOT EXISTS idx_ingestion_staging_topic ON ingestion_staging(topic);

CREATE TABLE IF NOT EXISTS ingestion_review_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_id UUID NOT NULL REFERENCES ingestion_staging(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('AUTO_SCORE', 'APPROVE', 'REJECT', 'PUBLISH')),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_review_events_staging ON ingestion_review_events(staging_id, created_at DESC);

ALTER TABLE ingestion_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_review_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read ingestion staging"
ON ingestion_staging FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY "Authenticated can insert ingestion staging"
ON ingestion_staging FOR INSERT
TO authenticated
WITH CHECK (TRUE);

CREATE POLICY "Authenticated can update ingestion staging"
ON ingestion_staging FOR UPDATE
TO authenticated
USING (TRUE)
WITH CHECK (TRUE);

CREATE POLICY "Authenticated can read ingestion events"
ON ingestion_review_events FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY "Authenticated can insert ingestion events"
ON ingestion_review_events FOR INSERT
TO authenticated
WITH CHECK (TRUE);
