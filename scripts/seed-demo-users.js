/**
 * Creates or updates Supabase Auth demo users + user_profiles for live demos.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (same as other API scripts).
 *
 * Usage: npm run seed:demo-users
 *
 * Accounts:
 *   student@costudy.in / 123456  → role STUDENT
 *   mentor@costudy.in  / 123456  → role TEACHER (mentor UI in app)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in costudy-api/.env"
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEMOS = [
  {
    email: "student@costudy.in",
    password: "123456",
    name: "Demo Student",
    role: "STUDENT",
    handle: "demo_student",
  },
  {
    email: "mentor@costudy.in",
    password: "123456",
    name: "Demo Mentor",
    role: "TEACHER",
    handle: "demo_mentor",
  },
];

async function upsertProfile(userId, { name, role, handle }) {
  const row = {
    id: userId,
    name,
    handle,
    role,
    bio:
      role === "TEACHER"
        ? "Demo mentor account for CoStudy demos."
        : "Demo student account for CoStudy demos.",
    exam_focus: "CMA Part 1",
    level: "STARTER",
    costudy_status: {
      subscription: "Basic",
      walletBalance: 0,
      isVerified: true,
      globalRank: 100,
    },
    reputation: {},
    performance: [],
    settings: {},
  };

  const { error } = await supabase.from("user_profiles").upsert(row, {
    onConflict: "id",
  });
  if (error) {
    console.warn(`user_profiles upsert warning for ${name}:`, error.message);
  }
}

async function findUserIdByEmail(email) {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) return u.id;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function ensureDemoUser(demo) {
  const { email, password, name, role, handle } = demo;
  const meta = { full_name: name, role };

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: meta,
  });

  if (!createErr && created?.user?.id) {
    await upsertProfile(created.user.id, { name, role, handle });
    console.log(`Created ${email} → ${created.user.id}`);
    return;
  }

  const exists =
    createErr &&
    /already|registered|exists/i.test(String(createErr.message || ""));
  if (!exists) {
    console.error(`createUser failed for ${email}:`, createErr);
    process.exit(1);
  }

  const id = await findUserIdByEmail(email);
  if (!id) {
    console.error(`Could not find existing user ${email} after duplicate error.`);
    process.exit(1);
  }

  const { error: updErr } = await supabase.auth.admin.updateUserById(id, {
    password,
    email_confirm: true,
    user_metadata: meta,
  });
  if (updErr) {
    console.error(`updateUser failed for ${email}:`, updErr);
    process.exit(1);
  }

  await upsertProfile(id, { name, role, handle });
  console.log(`Updated ${email} → ${id}`);
}

async function main() {
  for (const demo of DEMOS) {
    await ensureDemoUser(demo);
  }
  console.log("Done. Demo logins: student@costudy.in / mentor@costudy.in (password 123456).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
