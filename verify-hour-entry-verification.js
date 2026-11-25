// Temp verification: confirm the attendance-verification columns from
// server/migrations/2026-10-10-hour-entry-verification.sql exist on the
// live Supabase project, using the anon key from .env. PostgREST rejects
// unknown columns before RLS runs, so HTTP 200 (even with an empty row
// list) proves the columns exist; a 400 naming a column means the
// migration has not landed (or the PostgREST schema cache is stale).
require("dotenv").config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log("missing SUPABASE_URL / SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const COLUMNS = [
  "verification_status",
  "verified_by",
  "verified_at",
  "verification_note",
];

(async () => {
  const res = await fetch(
    `${url}/rest/v1/hour_entries?select=${COLUMNS.join(",")}&limit=3`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  const body = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(body);

  if (res.status === 200) {
    console.log(
      "ok [columns-exist] all four verification columns are selectable",
    );
    return;
  }
  if (res.status === 400 && /verification_/.test(body)) {
    console.log(
      "FAIL [columns-missing] migration has not landed (or the schema cache is stale)",
    );
    process.exitCode = 1;
    return;
  }
  console.log("UNEXPECTED response - inspect manually");
  process.exitCode = 1;
})().catch((err) => {
  console.log("FAIL [unexpected]:", err?.message ?? err);
  process.exit(1);
});
