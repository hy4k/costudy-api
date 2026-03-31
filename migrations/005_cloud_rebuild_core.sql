-- =============================================
-- CoStudy Cloud Rebuild Core (Phase 1)
-- Target: Supabase Cloud
-- =============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================
-- Profiles + classroom core
-- =============================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Aspirant',
  handle TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'STUDENT',
  avatar TEXT,
  bio TEXT,
  exam_focus TEXT DEFAULT 'CMA Part 1',
  level TEXT DEFAULT 'STARTER',
  costudy_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  reputation JSONB NOT NULL DEFAULT '{}'::jsonb,
  performance JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_exam_focus ON user_profiles(exam_focus);

CREATE TABLE IF NOT EXISTS study_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  description TEXT,
  color_theme TEXT DEFAULT 'bg-brand',
  creator_id UUID REFERENCES auth.users(id),
  room_type TEXT DEFAULT 'PUBLIC',
  group_subscription_id UUID,
  members_count INT DEFAULT 0,
  active_count INT DEFAULT 0,
  target_topics TEXT[] DEFAULT '{}',
  settings JSONB DEFAULT '{}'::jsonb,
  cluster_streak INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rooms_type ON study_rooms(room_type);

CREATE TABLE IF NOT EXISTS study_room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  signal_light TEXT NOT NULL DEFAULT 'GREEN',
  daily_contribution BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ,
  UNIQUE(room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_study_room_members_room ON study_room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_study_room_members_user ON study_room_members(user_id);

CREATE TABLE IF NOT EXISTS study_room_missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  metric TEXT NOT NULL DEFAULT 'QUESTIONS_SOLVED',
  target_value INT NOT NULL DEFAULT 100,
  current_value INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_study_room_missions_room ON study_room_missions(room_id);
CREATE INDEX IF NOT EXISTS idx_study_room_missions_status ON study_room_missions(status);

-- =============================================
-- Exam / question core
-- =============================================
CREATE TABLE IF NOT EXISTS question_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id TEXT UNIQUE,
  part TEXT NOT NULL,
  section TEXT,
  topic TEXT,
  question_kind TEXT NOT NULL CHECK (question_kind IN ('MCQ', 'ESSAY')),
  difficulty TEXT DEFAULT 'MEDIUM',
  source_kind TEXT NOT NULL DEFAULT 'official',
  question_text TEXT NOT NULL,
  options JSONB,
  correct_answer TEXT,
  explanation TEXT,
  reference_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_bank_part ON question_bank(part);
CREATE INDEX IF NOT EXISTS idx_question_bank_topic ON question_bank(topic);
CREATE INDEX IF NOT EXISTS idx_question_bank_kind ON question_bank(question_kind);

CREATE TABLE IF NOT EXISTS exam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  test_type TEXT NOT NULL,
  test_title TEXT NOT NULL,
  current_section TEXT NOT NULL DEFAULT 'MCQ',
  current_question_index INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  mcq_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  essay_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  mcq_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  essay_answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  essay_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  mcq_score INT,
  mcq_correct INT,
  mcq_total INT,
  mcq_time_spent_seconds INT NOT NULL DEFAULT 0,
  essay_time_spent_seconds INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mcq_completed_at TIMESTAMPTZ,
  essay_completed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exam_sessions_user ON exam_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_status ON exam_sessions(status);

-- =============================================
-- RAG content + vectors
-- =============================================
CREATE TABLE IF NOT EXISTS content_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  external_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_sources_name ON content_sources(name);

CREATE TABLE IF NOT EXISTS content_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES content_sources(id) ON DELETE SET NULL,
  document_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  part TEXT,
  section TEXT,
  topic TEXT,
  language TEXT DEFAULT 'en',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_documents_part ON content_documents(part);
CREATE INDEX IF NOT EXISTS idx_content_documents_topic ON content_documents(topic);

CREATE TABLE IF NOT EXISTS content_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_chunk_id TEXT,
  document_id TEXT NOT NULL REFERENCES content_documents(document_id) ON DELETE CASCADE,
  page_number INT,
  chunk_index INT NOT NULL,
  chunk_type TEXT NOT NULL DEFAULT 'other',
  question_no TEXT,
  content TEXT NOT NULL,
  tokens INT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_chunks_doc ON content_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_content_chunks_type ON content_chunks(chunk_type);
CREATE INDEX IF NOT EXISTS idx_content_chunks_question_no ON content_chunks(question_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_content_chunks_legacy_chunk_id_full
  ON content_chunks(legacy_chunk_id);

CREATE TABLE IF NOT EXISTS content_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id UUID NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE UNIQUE,
  embedding vector(1536) NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_embeddings_vector
  ON content_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- =============================================
-- AI telemetry + citations
-- =============================================
CREATE TABLE IF NOT EXISTS ai_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT,
  prompt_tokens INT,
  completion_tokens INT,
  latency_ms INT,
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES ai_requests(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  query_embedding vector(1536),
  top_k INT NOT NULL DEFAULT 10,
  threshold REAL NOT NULL DEFAULT 0.5,
  results_count INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS citation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES ai_requests(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  rank INT NOT NULL DEFAULT 1,
  similarity REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_citation_links_request ON citation_links(request_id, rank);

-- =============================================
-- RPC helpers used by frontend/service layer
-- =============================================
CREATE OR REPLACE FUNCTION increment_room_members(room_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE study_rooms
  SET members_count = COALESCE(members_count, 0) + 1
  WHERE id = room_id;
END;
$$;

CREATE OR REPLACE FUNCTION update_cluster_streak(p_room_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE study_rooms
  SET cluster_streak = COALESCE(cluster_streak, 0) + 1
  WHERE id = p_room_id;
END;
$$;

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.5,
  match_count INT DEFAULT 10,
  filter_document_id TEXT DEFAULT NULL,
  filter_chunk_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  document_id TEXT,
  page_number INT,
  chunk_index INT,
  chunk_type TEXT,
  question_no TEXT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id,
    c.document_id,
    c.page_number,
    c.chunk_index,
    c.chunk_type,
    c.question_no,
    c.content,
    (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity
  FROM content_embeddings e
  JOIN content_chunks c ON c.id = e.chunk_id
  WHERE
    (filter_document_id IS NULL OR c.document_id = filter_document_id)
    AND (filter_chunk_type IS NULL OR c.chunk_type = filter_chunk_type)
    AND (1 - (e.embedding <=> query_embedding)) >= match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- =============================================
-- Row level security
-- =============================================
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_room_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE retrieval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE citation_links ENABLE ROW LEVEL SECURITY;

-- user_profiles
CREATE POLICY "Users can read all public profiles"
ON user_profiles FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY "Users can update own profile"
ON user_profiles FOR UPDATE
TO authenticated
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- study_room_members
CREATE POLICY "Members visible to authenticated users"
ON study_room_members FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY "Users can join as themselves"
ON study_room_members FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own member row"
ON study_room_members FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- study_room_missions
CREATE POLICY "Missions readable by authenticated users"
ON study_room_missions FOR SELECT
TO authenticated
USING (TRUE);

-- exam_sessions
CREATE POLICY "Users can read own exam sessions"
ON exam_sessions FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can create own exam sessions"
ON exam_sessions FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own exam sessions"
ON exam_sessions FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- question_bank + RAG content (read-only to authenticated clients)
CREATE POLICY "Question bank readable by authenticated users"
ON question_bank FOR SELECT
TO authenticated
USING (is_active = TRUE);

CREATE POLICY "RAG documents readable by authenticated users"
ON content_documents FOR SELECT
TO authenticated
USING (TRUE);

CREATE POLICY "RAG chunks readable by authenticated users"
ON content_chunks FOR SELECT
TO authenticated
USING (TRUE);

-- ai telemetry is private to user for now
CREATE POLICY "Users can read own ai requests"
ON ai_requests FOR SELECT
TO authenticated
USING (auth.uid() = user_id);
