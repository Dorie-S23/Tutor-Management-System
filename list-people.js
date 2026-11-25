// One-shot: list tutors/volunteers with the details that matter for
// transcript generation (role, academic level, application marks).
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  const { data: users } = await s
    .from("users")
    .select("id, name, email, role")
    .in("role", ["tutor", "volunteer"])
    .order("name");
  console.log("USERS:");
  for (const u of users || []) {
    console.log(`  ${u.role} | ${u.name} | ${u.email} | ${u.id}`);
  }

  const { data: tutors } = await s
    .from("tutors")
    .select("id, name, academic_level");
  console.log("TUTORS:");
  for (const t of tutors || []) {
    console.log(`  ${t.name} | ${t.academic_level}`);
  }

  const { data: prefs } = await s
    .from("tutor_subject_preference")
    .select("tutor_id, status, tutor_mark, courses:course_id(course_code)");
  console.log("TUTOR PREFS:");
  for (const p of prefs || []) {
    console.log(
      `  ${p.courses?.course_code} | ${p.status} | mark ${p.tutor_mark} | tutor ${p.tutor_id}`,
    );
  }

  const { data: vols } = await s
    .from("course_volunteers")
    .select(
      "user_id, status, mark, courses:course_id(course_code), users:user_id(name, email)",
    );
  console.log("VOLUNTEER APPLICATIONS:");
  for (const v of vols || []) {
    console.log(
      `  ${v.users?.name} | ${v.courses?.course_code} | ${v.status} | mark ${v.mark}`,
    );
  }
})().catch((e) => console.log("ERR", e.message));
