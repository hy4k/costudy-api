-- ============================================
-- 007: Social / Community Tables + RPCs
-- ============================================

-- Add missing columns to user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS specialties TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS response_time TEXT DEFAULT '—',
  ADD COLUMN IF NOT EXISTS hourly_rate INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS learning_style TEXT DEFAULT 'Discussion';

-- ==========================================
-- POSTS & COMMENTS (Study Wall)
-- ==========================================
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'QUESTION',
  tags TEXT[] DEFAULT '{}',
  likes INTEGER DEFAULT 0,
  audit_status TEXT,
  audit_notes TEXT,
  auditor_id UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "posts_read" ON posts FOR SELECT USING (true);
CREATE POLICY "posts_insert" ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);
CREATE POLICY "posts_update" ON posts FOR UPDATE USING (auth.uid() = author_id OR auth.uid() = auditor_id);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  author_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id UUID REFERENCES comments(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comments_read" ON comments FOR SELECT USING (true);
CREATE POLICY "comments_insert" ON comments FOR INSERT WITH CHECK (auth.uid() = author_id);

-- ==========================================
-- NOTIFICATIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  type TEXT DEFAULT 'INFO',
  title TEXT,
  content TEXT,
  is_read BOOLEAN DEFAULT false,
  link TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notif_own" ON notifications FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- LIBRARY ITEMS
-- ==========================================
CREATE TABLE IF NOT EXISTS library_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  file_url TEXT,
  file_type TEXT,
  uploaded_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "library_read" ON library_items FOR SELECT USING (true);

-- ==========================================
-- STUDY ROOM RESOURCES & SESSIONS
-- ==========================================
CREATE TABLE IF NOT EXISTS study_room_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES study_rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT,
  category TEXT,
  file_url TEXT,
  uploaded_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE study_room_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "room_res_read" ON study_room_resources FOR SELECT USING (true);
CREATE POLICY "room_res_write" ON study_room_resources FOR ALL USING (auth.uid() = uploaded_by);

CREATE TABLE IF NOT EXISTS study_room_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES study_rooms(id) ON DELETE CASCADE,
  author_id UUID REFERENCES user_profiles(id),
  title TEXT,
  description TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'SCHEDULED',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE study_room_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "room_sess_read" ON study_room_sessions FOR SELECT USING (true);
CREATE POLICY "room_sess_write" ON study_room_sessions FOR INSERT WITH CHECK (auth.uid() = author_id);

-- ==========================================
-- TEACHER FEATURES
-- ==========================================
CREATE TABLE IF NOT EXISTS student_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  student_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(teacher_id, student_id)
);
ALTER TABLE student_enrollments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "enroll_own" ON student_enrollments FOR ALL USING (auth.uid() = teacher_id OR auth.uid() = student_id);

CREATE TABLE IF NOT EXISTS teacher_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'ANNOUNCEMENT',
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE teacher_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "broadcast_read" ON teacher_broadcasts FOR SELECT USING (true);
CREATE POLICY "broadcast_write" ON teacher_broadcasts FOR INSERT WITH CHECK (auth.uid() = teacher_id);

-- ==========================================
-- CHAT / DIRECT MESSAGES
-- ==========================================
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_group BOOLEAN DEFAULT false,
  name TEXT,
  context_type TEXT,
  context_title TEXT,
  status TEXT DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS chat_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(conversation_id, user_id)
);
ALTER TABLE chat_participants ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_conv_access" ON chat_conversations FOR ALL
  USING (id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid()));
CREATE POLICY "chat_part_access" ON chat_participants FOR ALL
  USING (user_id = auth.uid() OR conversation_id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid()));
CREATE POLICY "chat_msg_access" ON chat_messages FOR ALL
  USING (conversation_id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid()));

-- ==========================================
-- ALIGNMENT / BUDDY SYSTEM
-- ==========================================
CREATE TABLE IF NOT EXISTS alignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  peer_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  duration TEXT NOT NULL,
  goal TEXT,
  restrictions TEXT[],
  streak INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ACTIVE',
  start_date TIMESTAMPTZ DEFAULT now(),
  paused_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE alignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "align_own" ON alignments FOR ALL USING (auth.uid() = user_id OR auth.uid() = peer_id);

CREATE TABLE IF NOT EXISTS alignment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  receiver_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  duration TEXT NOT NULL,
  note TEXT,
  status TEXT DEFAULT 'PENDING',
  expires_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE alignment_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "areq_own" ON alignment_requests FOR ALL USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

CREATE TABLE IF NOT EXISTS tracking_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  target_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  tracked_since TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  UNIQUE(tracker_id, target_id)
);
ALTER TABLE tracking_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "track_own" ON tracking_records FOR ALL USING (auth.uid() = tracker_id OR auth.uid() = target_id);

-- ==========================================
-- MCQ WAR ROOM
-- ==========================================
CREATE TABLE IF NOT EXISTS mcq_war_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES study_rooms(id) ON DELETE CASCADE,
  topic TEXT,
  question_count INTEGER DEFAULT 10,
  time_limit_seconds INTEGER DEFAULT 300,
  status TEXT DEFAULT 'WAITING',
  room_accuracy FLOAT DEFAULT 0,
  created_by UUID REFERENCES user_profiles(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE mcq_war_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "war_read" ON mcq_war_sessions FOR SELECT USING (true);
CREATE POLICY "war_write" ON mcq_war_sessions FOR ALL USING (auth.uid() = created_by);

CREATE TABLE IF NOT EXISTS mcq_war_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES mcq_war_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  score INTEGER DEFAULT 0,
  questions_answered INTEGER DEFAULT 0,
  accuracy FLOAT DEFAULT 0,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, user_id)
);
ALTER TABLE mcq_war_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warp_read" ON mcq_war_participants FOR SELECT USING (true);
CREATE POLICY "warp_own" ON mcq_war_participants FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- WHITEBOARD
-- ==========================================
CREATE TABLE IF NOT EXISTS whiteboard_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES study_rooms(id) ON DELETE CASCADE,
  title TEXT,
  canvas_data JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES user_profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE whiteboard_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wb_read" ON whiteboard_sessions FOR SELECT USING (true);
CREATE POLICY "wb_write" ON whiteboard_sessions FOR ALL USING (auth.uid() = created_by);

-- ==========================================
-- GROUP SUBSCRIPTIONS & INVITES
-- ==========================================
CREATE TABLE IF NOT EXISTS group_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  plan_type TEXT DEFAULT 'PRO',
  billing_cycle TEXT,
  group_size INTEGER DEFAULT 1,
  base_price NUMERIC(10,2) DEFAULT 0,
  discount_percent NUMERIC(5,2) DEFAULT 0,
  per_person_price NUMERIC(10,2) DEFAULT 0,
  total_amount NUMERIC(10,2) DEFAULT 0,
  payment_status TEXT DEFAULT 'PENDING',
  payment_id TEXT,
  study_room_id UUID REFERENCES study_rooms(id),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE group_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gsub_own" ON group_subscriptions FOR ALL USING (auth.uid() = purchaser_id);

CREATE TABLE IF NOT EXISTS group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_subscription_id UUID REFERENCES group_subscriptions(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'PENDING',
  sent_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES user_profiles(id),
  accepted_at TIMESTAMPTZ
);
ALTER TABLE group_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ginv_read" ON group_invites FOR SELECT USING (true);

-- ==========================================
-- MENTOR SESSIONS & PAYMENTS
-- ==========================================
CREATE TABLE IF NOT EXISTS mentor_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE UNIQUE,
  is_online BOOLEAN DEFAULT false,
  available_for_flash BOOLEAN DEFAULT false,
  topics TEXT[] DEFAULT '{}',
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE mentor_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mavail_read" ON mentor_availability FOR SELECT USING (true);
CREATE POLICY "mavail_own" ON mentor_availability FOR ALL USING (auth.uid() = mentor_id);

CREATE TABLE IF NOT EXISTS mentor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentor_id UUID REFERENCES user_profiles(id),
  room_id UUID REFERENCES study_rooms(id),
  requester_id UUID REFERENCES user_profiles(id),
  topic TEXT,
  session_type TEXT DEFAULT 'FLASH',
  total_fee NUMERIC(10,2) DEFAULT 0,
  platform_fee_percent NUMERIC(5,2) DEFAULT 12.5,
  mentor_payout NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'REQUESTED',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  room_vouch BOOLEAN,
  mentor_rating INTEGER,
  feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE mentor_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "msess_access" ON mentor_sessions FOR ALL
  USING (auth.uid() = mentor_id OR auth.uid() = requester_id);

CREATE TABLE IF NOT EXISTS session_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES mentor_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'PENDING',
  payment_id TEXT,
  paid_at TIMESTAMPTZ,
  UNIQUE(session_id, user_id)
);
ALTER TABLE session_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "spay_own" ON session_payments FOR ALL USING (auth.uid() = user_id);

-- ==========================================
-- VOUCHES
-- ==========================================
CREATE TABLE IF NOT EXISTS vouches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(voucher_id, post_id)
);
ALTER TABLE vouches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vouch_read" ON vouches FOR SELECT USING (true);
CREATE POLICY "vouch_own" ON vouches FOR ALL USING (auth.uid() = voucher_id);

-- ==========================================
-- BADGES & GAMIFICATION
-- ==========================================
CREATE TABLE IF NOT EXISTS badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  icon TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "badges_read" ON badges FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS user_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  badge_id UUID REFERENCES badges(id) ON DELETE CASCADE,
  source_type TEXT,
  source_id TEXT,
  earned_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, badge_id)
);
ALTER TABLE user_badges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ubadge_read" ON user_badges FOR SELECT USING (true);
CREATE POLICY "ubadge_own" ON user_badges FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ==========================================
-- ROOM LEADERBOARD
-- ==========================================
CREATE TABLE IF NOT EXISTS room_leaderboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES study_rooms(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  essays_audited INTEGER DEFAULT 0,
  questions_solved INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  total_score INTEGER DEFAULT 0,
  UNIQUE(room_id, week_start)
);
ALTER TABLE room_leaderboard ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lb_read" ON room_leaderboard FOR SELECT USING (true);

-- ==========================================
-- INVITE CODES (user-level)
-- ==========================================
CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE UNIQUE,
  code TEXT UNIQUE NOT NULL,
  max_uses INTEGER DEFAULT 5,
  uses_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invcode_own" ON invite_codes FOR ALL USING (auth.uid() = owner_id);
CREATE POLICY "invcode_read" ON invite_codes FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS invite_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID REFERENCES invite_codes(id) ON DELETE CASCADE,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  used_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE invite_uses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invuse_own" ON invite_uses FOR ALL USING (auth.uid() = user_id);
