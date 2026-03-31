-- 009: Normalize question_bank.part + harden social RLS (applied to Supabase Cloud 2026-03-28)
--
-- Part normalization (run anytime; no-op if already canonical)
UPDATE question_bank SET part = 'Part 1'
WHERE part IS NOT NULL AND (
  trim(part) = 'Part1'
  OR lower(replace(trim(part), ' ', '')) = 'part1'
);
UPDATE question_bank SET part = 'Part 2'
WHERE part IS NOT NULL AND (
  trim(part) = 'Part2'
  OR lower(replace(trim(part), ' ', '')) = 'part2'
);

-- --- Posts & comments: signed-in users only (Study Wall feed) ---
DROP POLICY IF EXISTS posts_read ON posts;
DROP POLICY IF EXISTS posts_read_all ON posts;
DROP POLICY IF EXISTS posts_read_authenticated ON posts;
CREATE POLICY posts_read_authenticated ON posts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS comments_read ON comments;
DROP POLICY IF EXISTS comments_read_all ON comments;
DROP POLICY IF EXISTS comments_read_authenticated ON comments;
CREATE POLICY comments_read_authenticated ON comments FOR SELECT TO authenticated USING (true);

-- --- Notifications: own rows only (split from single ALL policy) ---
DROP POLICY IF EXISTS notif_own ON notifications;
CREATE POLICY notifications_select_own ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY notifications_insert_own ON notifications FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY notifications_update_own ON notifications FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY notifications_delete_own ON notifications FOR DELETE USING (auth.uid() = user_id);

-- --- Authenticated read for catalog / community tables ---
DROP POLICY IF EXISTS library_read ON library_items;
CREATE POLICY library_read_authenticated ON library_items FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS room_res_read ON study_room_resources;
CREATE POLICY room_res_read_authenticated ON study_room_resources FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS room_sess_read ON study_room_sessions;
CREATE POLICY room_sess_read_authenticated ON study_room_sessions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS broadcast_read ON teacher_broadcasts;
CREATE POLICY broadcast_read_authenticated ON teacher_broadcasts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS lb_read ON room_leaderboard;
CREATE POLICY lb_read_authenticated ON room_leaderboard FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS badges_read ON badges;
CREATE POLICY badges_read_authenticated ON badges FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS ubadge_read ON user_badges;
CREATE POLICY ubadge_read_authenticated ON user_badges FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS vouch_read ON vouches;
CREATE POLICY vouch_read_authenticated ON vouches FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS war_read ON mcq_war_sessions;
CREATE POLICY war_read_authenticated ON mcq_war_sessions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS warp_read ON mcq_war_participants;
CREATE POLICY warp_read_authenticated ON mcq_war_participants FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS mavail_read ON mentor_availability;
CREATE POLICY mavail_read_authenticated ON mentor_availability FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS wb_read ON whiteboard_sessions;
CREATE POLICY wb_read_authenticated ON whiteboard_sessions FOR SELECT TO authenticated USING (true);

-- invite_codes: only owner row (RPC validate_invite_code / create_user_invite_code are SECURITY DEFINER)
DROP POLICY IF EXISTS invcode_read ON invite_codes;

-- group_invites: authenticated read (invitees must load row by code before accept)
DROP POLICY IF EXISTS ginv_read ON group_invites;
DROP POLICY IF EXISTS ginv_subscription_members ON group_invites;
CREATE POLICY ginv_read_authenticated ON group_invites FOR SELECT TO authenticated USING (true);

-- --- Chat: allow INSERT on conversations + participants (DM flow) ---
DROP POLICY IF EXISTS chat_conv_access ON chat_conversations;
DROP POLICY IF EXISTS chat_part_access ON chat_participants;
DROP POLICY IF EXISTS chat_msg_access ON chat_messages;

CREATE POLICY chat_conv_select ON chat_conversations
  FOR SELECT TO authenticated USING (
    id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid())
  );
CREATE POLICY chat_conv_insert ON chat_conversations
  FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY chat_conv_update ON chat_conversations
  FOR UPDATE TO authenticated USING (
    id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid())
  );

CREATE POLICY chat_part_select ON chat_participants
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR conversation_id IN (SELECT conversation_id FROM chat_participants cp2 WHERE cp2.user_id = auth.uid())
  );
CREATE POLICY chat_part_insert ON chat_participants
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM chat_participants cp
      WHERE cp.conversation_id = chat_participants.conversation_id
        AND cp.user_id = auth.uid()
    )
  );
CREATE POLICY chat_part_delete ON chat_participants
  FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY chat_msg_select ON chat_messages
  FOR SELECT TO authenticated USING (
    conversation_id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid())
  );
CREATE POLICY chat_msg_insert ON chat_messages
  FOR INSERT TO authenticated WITH CHECK (
    sender_id = auth.uid()
    AND conversation_id IN (SELECT conversation_id FROM chat_participants WHERE user_id = auth.uid())
  );
CREATE POLICY chat_msg_update ON chat_messages
  FOR UPDATE TO authenticated USING (sender_id = auth.uid());
CREATE POLICY chat_msg_delete ON chat_messages
  FOR DELETE TO authenticated USING (sender_id = auth.uid());
