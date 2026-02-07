-- =============================================
-- CoStudy Core Tables Migration
-- Run this in Supabase SQL Editor
-- =============================================

-- =============================================
-- POSTS & COMMENTS (Social Wall)
-- =============================================

CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    author_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'QUESTION', -- QUESTION, RESOURCE, MCQ_SHARE, ESSAY_REQUEST, DISCUSSION
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
    room_type TEXT DEFAULT 'PUBLIC', -- PUBLIC, PRIVATE, GROUP_PREMIUM
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
    status TEXT DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED, DROPPED
    enrolled_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(teacher_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_teacher ON student_enrollments(teacher_id);

CREATE TABLE IF NOT EXISTS teacher_broadcasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'GENERAL', -- GENERAL, URGENT, RESOURCE
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_teacher ON teacher_broadcasts(teacher_id);

-- =============================================
-- NOTIFICATIONS
-- =============================================

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- ALIGNMENT_REQUEST, VOUCH, MENTION, BROADCAST, etc.
    title TEXT NOT NULL,
    message TEXT,
    data JSONB DEFAULT '{}'::jsonb,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- =============================================
-- STUDY ROOM SESSIONS (Scheduled Events)
-- =============================================

CREATE TABLE IF NOT EXISTS study_room_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES study_rooms(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES auth.users(id),
    title TEXT NOT NULL,
    description TEXT,
    start_time TIMESTAMPTZ NOT NULL,
    duration_minutes INT DEFAULT 60,
    session_type TEXT DEFAULT 'STUDY', -- STUDY, MCQ_WAR, MOCK, DISCUSSION
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
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, -- For profile vouches
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(voucher_id, post_id),
    CHECK (post_id IS NOT NULL OR user_id IS NOT NULL)
);

-- =============================================
-- RLS POLICIES
-- =============================================

-- Posts
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view posts" ON posts FOR SELECT USING (true);
CREATE POLICY "Users can create posts" ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "Users can update own posts" ON posts FOR UPDATE USING (auth.uid() = author_id);

-- Comments
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view comments" ON comments FOR SELECT USING (true);
CREATE POLICY "Users can create comments" ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);

-- Study Rooms
ALTER TABLE study_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view public rooms" ON study_rooms FOR SELECT USING (room_type = 'PUBLIC' OR creator_id = auth.uid());
CREATE POLICY "Users can create rooms" ON study_rooms FOR INSERT WITH CHECK (auth.uid() = creator_id);

-- Enrollments
ALTER TABLE student_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Teachers can view own enrollments" ON student_enrollments FOR SELECT USING (auth.uid() = teacher_id OR auth.uid() = student_id);
CREATE POLICY "Teachers can manage enrollments" ON student_enrollments FOR ALL USING (auth.uid() = teacher_id);

-- Broadcasts
ALTER TABLE teacher_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view broadcasts" ON teacher_broadcasts FOR SELECT USING (true);
CREATE POLICY "Teachers can create broadcasts" ON teacher_broadcasts FOR INSERT WITH CHECK (auth.uid() = teacher_id);

-- Notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Vouches
ALTER TABLE vouches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view vouches" ON vouches FOR SELECT USING (true);
CREATE POLICY "Users can vouch" ON vouches FOR INSERT WITH CHECK (auth.uid() = voucher_id);
CREATE POLICY "Users can remove own vouch" ON vouches FOR DELETE USING (auth.uid() = voucher_id);

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Update post likes count when vouch added/removed
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

CREATE TRIGGER trigger_vouch_count
AFTER INSERT OR DELETE ON vouches
FOR EACH ROW
WHEN (pg_trigger_depth() = 0)
EXECUTE FUNCTION update_post_vouch_count();
