-- ============================================
-- 008: Social RPCs
-- ============================================

-- 1. increment_post_likes
CREATE OR REPLACE FUNCTION increment_post_likes(post_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE posts SET likes = likes + 1 WHERE id = post_id;
END;
$$;

-- 2. increment_post_vouches (alias used by vouchService)
CREATE OR REPLACE FUNCTION increment_post_vouches(post_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE posts SET likes = likes + 1 WHERE id = post_id;
END;
$$;

-- 3. decrement_post_vouches
CREATE OR REPLACE FUNCTION decrement_post_vouches(post_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE posts SET likes = GREATEST(likes - 1, 0) WHERE id = post_id;
END;
$$;

-- 4. increment_room_members
CREATE OR REPLACE FUNCTION increment_room_members(room_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE study_rooms SET members_count = COALESCE(members_count, 0) + 1 WHERE id = room_id;
END;
$$;

-- 5. update_cluster_streak
CREATE OR REPLACE FUNCTION update_cluster_streak(p_room_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  all_contributed BOOLEAN;
BEGIN
  SELECT bool_and(COALESCE(daily_contribution, false))
    INTO all_contributed
    FROM study_room_members
   WHERE room_id = p_room_id AND status = 'ACTIVE';

  IF all_contributed THEN
    UPDATE study_rooms SET cluster_streak = COALESCE(cluster_streak, 0) + 1 WHERE id = p_room_id;
    UPDATE study_room_members SET daily_contribution = false WHERE room_id = p_room_id;
  END IF;
END;
$$;

-- 6. increment_alignment_streak
CREATE OR REPLACE FUNCTION increment_alignment_streak(alignment_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE alignments SET streak = COALESCE(streak, 0) + 1, updated_at = now() WHERE id = alignment_id;
END;
$$;

-- 7. accept_alignment_request — creates alignment, marks request ACCEPTED
CREATE OR REPLACE FUNCTION accept_alignment_request(request_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  req RECORD;
  new_id UUID;
BEGIN
  SELECT * INTO req FROM alignment_requests WHERE id = request_id AND status = 'PENDING';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found or already responded';
  END IF;

  UPDATE alignment_requests
     SET status = 'ACCEPTED', responded_at = now()
   WHERE id = request_id;

  INSERT INTO alignments (user_id, peer_id, purpose, duration, status, streak, start_date)
    VALUES (req.receiver_id, req.sender_id, req.purpose, req.duration, 'ACTIVE', 0, now())
    RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- 8. validate_invite_code
CREATE OR REPLACE FUNCTION validate_invite_code(input_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT * INTO inv FROM invite_codes WHERE code = input_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Invalid code');
  END IF;
  IF inv.uses_count >= inv.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Code has reached maximum uses');
  END IF;
  RETURN jsonb_build_object(
    'valid', true,
    'code', inv.code,
    'owner_id', inv.owner_id,
    'uses_remaining', inv.max_uses - inv.uses_count
  );
END;
$$;

-- 9. use_invite_code
CREATE OR REPLACE FUNCTION use_invite_code(input_code TEXT, new_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT * INTO inv FROM invite_codes WHERE code = input_code;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid code');
  END IF;
  IF inv.uses_count >= inv.max_uses THEN
    RETURN jsonb_build_object('success', false, 'error', 'Code exhausted');
  END IF;

  INSERT INTO invite_uses (code_id, user_id) VALUES (inv.id, new_user_id);
  UPDATE invite_codes SET uses_count = uses_count + 1 WHERE id = inv.id;

  RETURN jsonb_build_object(
    'success', true,
    'code', inv.code,
    'invited_by', inv.owner_id,
    'uses_remaining', inv.max_uses - inv.uses_count - 1
  );
END;
$$;

-- 10. get_invite_stats
CREATE OR REPLACE FUNCTION get_invite_stats(user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inv RECORD;
  invitees JSONB;
BEGIN
  SELECT * INTO inv FROM invite_codes WHERE owner_id = user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_code', false);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'user_id', iu.user_id,
    'used_at', iu.used_at,
    'name', COALESCE(up.name, 'Unknown'),
    'avatar', COALESCE(up.avatar, '')
  )), '[]'::jsonb)
    INTO invitees
    FROM invite_uses iu
    LEFT JOIN user_profiles up ON up.id = iu.user_id
   WHERE iu.code_id = inv.id;

  RETURN jsonb_build_object(
    'has_code', true,
    'code', inv.code,
    'max_uses', inv.max_uses,
    'uses_count', inv.uses_count,
    'uses_remaining', inv.max_uses - inv.uses_count,
    'invitees', invitees,
    'created_at', inv.created_at
  );
END;
$$;

-- 11. create_user_invite_code
CREATE OR REPLACE FUNCTION create_user_invite_code(user_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  new_code TEXT;
  existing RECORD;
BEGIN
  SELECT * INTO existing FROM invite_codes WHERE owner_id = user_id;
  IF FOUND THEN
    RETURN existing.code;
  END IF;

  new_code := upper(substr(md5(random()::text), 1, 8));
  INSERT INTO invite_codes (owner_id, code) VALUES (user_id, new_code);
  RETURN new_code;
END;
$$;
