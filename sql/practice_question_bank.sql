-- CoStudy practice question bank (independent of exam attempts)
-- Run in Supabase SQL editor once, then:
--   POST /api/admin/question-bank/extract  (header X-Admin-Key)

CREATE TABLE IF NOT EXISTS public.practice_question_bank (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stem             TEXT NOT NULL,
  choices          JSONB NOT NULL,
  correct_key      TEXT,
  explanation      TEXT,
  topic            TEXT,
  difficulty       TEXT NOT NULL DEFAULT 'medium',
  source_chunk_id  UUID,
  source_document  TEXT,
  question_no      TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(choices) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_practice_bank_topic ON public.practice_question_bank (topic);
CREATE INDEX IF NOT EXISTS idx_practice_bank_active ON public.practice_question_bank (is_active);
CREATE INDEX IF NOT EXISTS idx_practice_bank_source ON public.practice_question_bank (source_chunk_id);

-- Best-effort uniqueness for re-runs (stem + source chunk)
CREATE UNIQUE INDEX IF NOT EXISTS uq_practice_bank_source_stem
  ON public.practice_question_bank (source_chunk_id, md5(stem))
  WHERE source_chunk_id IS NOT NULL;

ALTER TABLE public.practice_question_bank ENABLE ROW LEVEL SECURITY;

-- Students can read active bank items (no correct_key required client-side if you filter later)
DROP POLICY IF EXISTS practice_bank_read_authenticated ON public.practice_question_bank;
CREATE POLICY practice_bank_read_authenticated
  ON public.practice_question_bank
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Writes only via service role (API)
