-- =============================================
-- CoStudy Combined Migration
-- Run this ONCE in Supabase SQL Editor
-- =============================================

-- =============================================
-- CMA Alignment Network (CAN) Tables
-- =============================================

-- Safe enum creation (ignore if exists)
DO $$ BEGIN
    CREATE TYPE alignment_purpose AS ENUM (
        'MCQ_DRILL',
        'ACCOUNTABILITY',
        'REVISION_SPRINT',
        'ESSAY_AUDIT',
        'MOCK_PREP',
        'GENERAL'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE alignment_status AS ENUM (
        'ACTIVE',
        'PAUSED',
        'EXPIRED',
        'ARCHIVED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE request_status AS ENUM (
        'PENDING',
        'ACCEPTED',
        'DECLINED',
        'EXPIRED'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================
-- ALIGNMENTS (Active Study Partnerships)
-- =============================================
CREATE TABLE IF NOT EXISTS alignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    peer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    purpose alignment_purpose DEFAULT 'GENERAL',
    duration TEXT NOT NULL DEFAULT '7 Days',
    goal TEXT,
    streak INT DEFAULT 0,
    status alignment_status DEFAULT 'ACTIVE',
    restrictions JSONB DEFAULT '[]'::jsonb,
    paused_until TIMESTAMPTZ,
    start_date TIMESTAMPTZ DEFAULT NOW(),
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_alignments_user ON alignments(user_id);
CREATE INDEX IF NOT EXISTS idx_alignments_peer ON alignments(peer_id);
CREATE INDEX IF NOT EXISTS idx_alignments_status ON alignments(status);

-- =============================================
-- ALIGNMENT REQUESTS (Pending Treaties)
-- =============================================
CREATE TABLE IF NOT EXISTS alignment_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    purpose alignment_purpose DEFAULT 'GENERAL',
    duration TEXT NOT NULL DEFAULT '7 Days',
    note TEXT,
    status request_status DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    responded_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_alignment_requests_receiver ON alignment_requests(receiver_id, status);
CREATE INDEX IF NOT EXISTS idx_alignment_requests_sender ON alignment_requests(sender_id);

-- =============================================
-- TRACKING RECORDS (Academic Radar)
-- =============================================
CREATE TABLE IF NOT EXISTS tracking_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracker_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tracked_since TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tracker_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_tracking_tracker ON tracking_records(tracker_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tracking_target ON tracking_records(target_id, is_active);

-- =============================================
-- POSTS & COMMENTS (Social Wall)
-- =============================================

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'QUESTION',
    tags TEXT[] DEFAULT '{}',
    likes INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    likes INT DEFAULT 0,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

-- =============================================
-- STUDY ROOMS
-- =============================================

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

-- =============================================
-- TEACHER/MENTOR FEATURES
-- =============================================

CREATE TABLE IF NOT EXISTS student_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'ACTIVE',
    enrolled_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(teacher_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_teacher ON student_enrollments(teacher_id);

CREATE TABLE IF NOT EXISTS teacher_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'GENERAL',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_teacher ON teacher_broadcasts(teacher_id);

-- =============================================
-- NOTIFICATIONS
-- =============================================

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN DEFAULT FALSE,
    link TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- =============================================
-- STUDY ROOM SESSIONS
-- =============================================

CREATE TABLE IF NOT EXISTS study_room_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id),
    title TEXT NOT NULL,
    description TEXT,
    start_time TIMESTAMPTZ NOT NULL,
    duration_minutes INT DEFAULT 60,
    session_type TEXT DEFAULT 'STUDY',
    max_participants INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_room ON study_room_sessions(room_id);

-- =============================================
-- VOUCHES (Professional Endorsements)
-- =============================================

CREATE TABLE IF NOT EXISTS vouches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(voucher_id, post_id)
);

-- =============================================
-- RLS POLICIES
-- =============================================

-- Enable RLS on all tables
ALTER TABLE alignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE alignment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE study_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouches ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (safe, will ignore if not exists)
DROP POLICY IF EXISTS "Users can view own alignments" ON alignments;
DROP POLICY IF EXISTS "Users can create alignments" ON alignments;
DROP POLICY IF EXISTS "Users can update own alignments" ON alignments;
DROP POLICY IF EXISTS "Users can view own requests" ON alignment_requests;
DROP POLICY IF EXISTS "Users can send requests" ON alignment_requests;
DROP POLICY IF EXISTS "Receivers can update requests" ON alignment_requests;
DROP POLICY IF EXISTS "Users can view own tracking" ON tracking_records;
DROP POLICY IF EXISTS "Users can track others" ON tracking_records;
DROP POLICY IF EXISTS "Users can stop tracking" ON tracking_records;
DROP POLICY IF EXISTS "Anyone can view posts" ON posts;
DROP POLICY IF EXISTS "Users can create posts" ON posts;
DROP POLICY IF EXISTS "Users can update own posts" ON posts;
DROP POLICY IF EXISTS "Anyone can view comments" ON comments;
DROP POLICY IF EXISTS "Users can create comments" ON comments;
DROP POLICY IF EXISTS "Anyone can view public rooms" ON study_rooms;
DROP POLICY IF EXISTS "Users can create rooms" ON study_rooms;
DROP POLICY IF EXISTS "Teachers can view own enrollments" ON student_enrollments;
DROP POLICY IF EXISTS "Teachers can manage enrollments" ON student_enrollments;
DROP POLICY IF EXISTS "Anyone can view broadcasts" ON teacher_broadcasts;
DROP POLICY IF EXISTS "Teachers can create broadcasts" ON teacher_broadcasts;
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Anyone can view vouches" ON vouches;
DROP POLICY IF EXISTS "Users can vouch" ON vouches;
DROP POLICY IF EXISTS "Users can remove own vouch" ON vouches;

-- Alignments policies
CREATE POLICY "Users can view own alignments" ON alignments
    FOR SELECT USING (auth.uid() = user_id OR auth.uid() = peer_id);
CREATE POLICY "Users can create alignments" ON alignments
    FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own alignments" ON alignments
    FOR UPDATE USING (auth.uid() = user_id);

-- Requests policies
CREATE POLICY "Users can view own requests" ON alignment_requests
    FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "Users can send requests" ON alignment_requests
    FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Receivers can update requests" ON alignment_requests
    FOR UPDATE USING (auth.uid() = receiver_id);

-- Tracking policies
CREATE POLICY "Users can view own tracking" ON tracking_records
    FOR SELECT USING (auth.uid() = tracker_id OR auth.uid() = target_id);
CREATE POLICY "Users can track others" ON tracking_records
    FOR INSERT WITH CHECK (auth.uid() = tracker_id);
CREATE POLICY "Users can stop tracking" ON tracking_records
    FOR DELETE USING (auth.uid() = tracker_id);

-- Posts policies
CREATE POLICY "Anyone can view posts" ON posts FOR SELECT USING (true);
CREATE POLICY "Users can create posts" ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can update own posts" ON posts FOR UPDATE USING (auth.uid() = author_id);

-- Comments policies
CREATE POLICY "Anyone can view comments" ON comments FOR SELECT USING (true);
CREATE POLICY "Users can create comments" ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);

-- Study rooms policies
CREATE POLICY "Anyone can view public rooms" ON study_rooms FOR SELECT USING (room_type = 'PUBLIC' OR creator_id = auth.uid());
CREATE POLICY "Users can create rooms" ON study_rooms FOR INSERT WITH CHECK (auth.uid() = creator_id);

-- Enrollments policies
CREATE POLICY "Teachers can view own enrollments" ON student_enrollments FOR SELECT USING (auth.uid() = teacher_id OR auth.uid() = student_id);
CREATE POLICY "Teachers can manage enrollments" ON student_enrollments FOR ALL USING (auth.uid() = teacher_id);

-- Broadcasts policies
CREATE POLICY "Anyone can view broadcasts" ON teacher_broadcasts FOR SELECT USING (true);
CREATE POLICY "Teachers can create broadcasts" ON teacher_broadcasts FOR INSERT WITH CHECK (auth.uid() = teacher_id);

-- Notifications policies
CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Vouches policies
CREATE POLICY "Anyone can view vouches" ON vouches FOR SELECT USING (true);
CREATE POLICY "Users can vouch" ON vouches FOR INSERT WITH CHECK (auth.uid() = voucher_id);
CREATE POLICY "Users can remove own vouch" ON vouches FOR DELETE USING (auth.uid() = voucher_id);

-- =============================================
-- RPC FUNCTIONS
-- =============================================

-- Accept alignment request
CREATE OR REPLACE FUNCTION accept_alignment_request(request_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    req alignment_requests%ROWTYPE;
    new_alignment_id UUID;
BEGIN
    SELECT * INTO req FROM alignment_requests WHERE id = request_id AND status = 'PENDING';
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found or already processed';
    END IF;
    
    INSERT INTO alignments (user_id, peer_id, purpose, duration, goal)
    VALUES (req.receiver_id, req.sender_id, req.purpose, req.duration, req.note)
    RETURNING id INTO new_alignment_id;
    
    INSERT INTO alignments (user_id, peer_id, purpose, duration, goal)
    VALUES (req.sender_id, req.receiver_id, req.purpose, req.duration, req.note)
    ON CONFLICT (user_id, peer_id) DO NOTHING;
    
    UPDATE alignment_requests 
    SET status = 'ACCEPTED', responded_at = NOW()
    WHERE id = request_id;
    
    RETURN new_alignment_id;
END;
$$;

-- Increment streak
CREATE OR REPLACE FUNCTION increment_alignment_streak(alignment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE alignments 
    SET streak = streak + 1, updated_at = NOW()
    WHERE id = alignment_id;
END;
$$;

-- Vouch count trigger
CREATE OR REPLACE FUNCTION update_post_vouch_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE posts SET likes = likes + 1 WHERE id = NEW.post_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE posts SET likes = GREATEST(0, likes - 1) WHERE id = OLD.post_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_vouch_count ON vouches;
CREATE TRIGGER trigger_vouch_count
AFTER INSERT OR DELETE ON vouches
FOR EACH ROW
WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION update_post_vouch_count();

-- =============================================
-- DONE!
-- =============================================
SELECT 'Migration complete! Tables created: alignments, alignment_requests, tracking_records, posts, comments, study_rooms, student_enrollments, teacher_broadcasts, notifications, study_room_sessions, vouches' as status;
