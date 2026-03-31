import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const APPROVE_THRESHOLD = Number(process.env.CORPUS_APPROVE_THRESHOLD || 80);
const REJECT_THRESHOLD = Number(process.env.CORPUS_REJECT_THRESHOLD || 60);
const BATCH_SIZE = 300;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function fetchIds(filter) {
  const allIds = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("ingestion_staging")
      .select("id")
      .eq("status", "PENDING_REVIEW")
      .filter("quality_score", ...filter)
      .range(offset, offset + 999);
    if (error) throw error;
    if (!data?.length) break;
    allIds.push(...data.map((r) => r.id));
    offset += data.length;
    if (data.length < 1000) break;
  }
  return allIds;
}

async function batchUpdate(ids, status) {
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("ingestion_staging")
      .update({ status, updated_at: new Date().toISOString() })
      .in("id", batch);
    if (error) throw error;

    const events = batch.map((id) => ({
      staging_id: id,
      action: status === "APPROVED" ? "APPROVE" : "REJECT",
      payload: {
        automated: true,
        threshold: { approve: APPROVE_THRESHOLD, reject: REJECT_THRESHOLD },
      },
    }));
    const { error: evErr } = await supabase
      .from("ingestion_review_events")
      .insert(events);
    if (evErr) throw evErr;

    updated += batch.length;
  }
  return updated;
}

async function main() {
  const approveIds = await fetchIds(["gte", APPROVE_THRESHOLD]);
  const rejectIds = await fetchIds(["lt", REJECT_THRESHOLD]);

  console.log(
    `[triage] found: approve=${approveIds.length}, reject=${rejectIds.length}`
  );

  const approved = await batchUpdate(approveIds, "APPROVED");
  const rejected = await batchUpdate(rejectIds, "REJECTED");

  console.log(`[triage] approved=${approved}, rejected=${rejected}`);
  console.log(
    `[triage] records between ${REJECT_THRESHOLD}-${APPROVE_THRESHOLD - 1} stay in PENDING_REVIEW`
  );
}

main().catch((e) => {
  console.error("[triage] failed", e);
  process.exit(1);
});
