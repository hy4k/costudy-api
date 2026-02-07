-- =============================================
-- CMA Alignment Network (CAN) Tables
-- =============================================

-- Alignment Purpose Enum
CREATE TYPE alignment_purpose AS ENUM (
    'MCQ_DRILL',
    'ACCOUNTABILITY',
    'REVISION_SPRINT',
    'ESSAY_AUDIT',
    'MOCK_PREP',
    'GENERAL'
);

-- Alignment Status Enum
CREATE TYPE alignment_status AS ENUM (
    'ACTIVE',
    'PAUSED',
    'EXPIRED',
    'ARCHIVED'
);

-- Request Status Enum
CREATE TYPE request_status AS ENUM (
    'PENDING',
    'ACCEPTED',
    'DECLINED',
    'EXPIRED'
);

-- =============================================
-- ALIGNMENTS (Active Study Partnerships)
-- =============================================
CREATE TABLE IF NOT EXISTS alignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    peer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    purpose alignment_purpose DEFAULT 'GENERAL',
    duration TEXT NOT NULL DEFAULT '7 Days', -- '7 Days', '14 Days', '30 Days', 'Until Exam'
    goal TEXT,
    streak INT DEFAULT 0,
    status alignment_status DEFAULT 'ACTIVE',
    restrictions JSONB DEFAULT '[]'::jsonb, -- ['NO_ESSAYS', 'MCQ_ONLY', etc.]
    paused_until TIMESTAMPTZ,
    start_date TIMESTAMPTZ DEFAULT NOW(),
    end_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate alignments between same users
    UNIQUE(user_id, peer_id)
);

-- Index for fast lookups
CREATE INDEX idx_alignments_user ON alignments(user_id);
CREATE INDEX idx_alignments_peer ON alignments(peer_id);
CREATE INDEX idx_alignments_status ON alignments(status);

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
    expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days'),
    
    -- Prevent duplicate pending requests
    UNIQUE(sender_id, receiver_id, status)
);

-- Index for fast lookups
CREATE INDEX idx_alignment_requests_receiver ON alignment_requests(receiver_id, status);
CREATE INDEX idx_alignment_requests_sender ON alignment_requests(sender_id);

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
    
    -- One tracking record per pair
    UNIQUE(tracker_id, target_id)
);

-- Index for lookups
CREATE INDEX idx_tracking_tracker ON tracking_records(tracker_id, is_active);
CREATE INDEX idx_tracking_target ON tracking_records(target_id, is_active);

-- =============================================
-- RPC FUNCTIONS
-- =============================================

-- Accept alignment request and create alignment
CREATE OR REPLACE FUNCTION accept_alignment_request(request_id UUID)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    req alignment_requests%ROWTYPE;
    new_alignment_id UUID;
BEGIN
    -- Get the request
    SELECT * INTO req FROM alignment_requests WHERE id = request_id AND status = 'PENDING';
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request not found or already processed';
    END IF;
    
    -- Create the alignment
    INSERT INTO alignments (user_id, peer_id, purpose, duration, goal)
    VALUES (req.receiver_id, req.sender_id, req.purpose, req.duration, req.note)
    RETURNING id INTO new_alignment_id;
    
    -- Also create reverse alignment (both users are aligned with each other)
    INSERT INTO alignments (user_id, peer_id, purpose, duration, goal)
    VALUES (req.sender_id, req.receiver_id, req.purpose, req.duration, req.note)
    ON CONFLICT (user_id, peer_id) DO NOTHING;
    
    -- Update request status
    UPDATE alignment_requests 
    SET status = 'ACCEPTED', responded_at = NOW()
    WHERE id = request_id;
    
    RETURN new_alignment_id;
END;
$$;

-- Increment alignment streak
CREATE OR REPLACE FUNCTION increment_alignment_streak(alignment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE alignments 
    SET streak = streak + 1, updated_at = NOW()
    WHERE id = alignment_id;
END;
$$;

-- Get user's observers (people tracking them)
CREATE OR REPLACE FUNCTION get_observers(user_id UUID)
RETURNS TABLE (
    tracker_id UUID,
    tracker_name TEXT,
    tracker_avatar TEXT,
    tracked_since TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
    SELECT 
        tr.tracker_id,
        up.name,
        up.avatar,
        tr.tracked_since
    FROM tracking_records tr
    JOIN user_profiles up ON up.id = tr.tracker_id
    WHERE tr.target_id = user_id AND tr.is_active = TRUE;
$$;

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

ALTER TABLE alignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE alignment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_records ENABLE ROW LEVEL SECURITY;

-- Alignments: Users can see their own alignments
CREATE POLICY "Users can view own alignments" ON alignments
    FOR SELECT USING (auth.uid() = user_id OR auth.uid() = peer_id);

CREATE POLICY "Users can create alignments" ON alignments
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own alignments" ON alignments
    FOR UPDATE USING (auth.uid() = user_id);

-- Requests: Users can see requests they sent or received
CREATE POLICY "Users can view own requests" ON alignment_requests
    FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

CREATE POLICY "Users can send requests" ON alignment_requests
    FOR INSERT WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Receivers can update requests" ON alignment_requests
    FOR UPDATE USING (auth.uid() = receiver_id);

-- Tracking: Users can see who they track and who tracks them
CREATE POLICY "Users can view own tracking" ON tracking_records
    FOR SELECT USING (auth.uid() = tracker_id OR auth.uid() = target_id);

CREATE POLICY "Users can track others" ON tracking_records
    FOR INSERT WITH CHECK (auth.uid() = tracker_id);

CREATE POLICY "Users can stop tracking" ON tracking_records
    FOR DELETE USING (auth.uid() = tracker_id);
