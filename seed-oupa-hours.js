// One-shot seed: October hour_entries for a named user.
// The live API only accepts entries logged while a session is actually
// happening, so backfilling a month has to write straight to the database.
// Each row is exactly what POST /api/hour-entries would have written for a
// scheduled slot: the slot's own weekday and times (so the attendance
// verification queue labels it Tutorial/Lab), hours rounded to the whole
// hour the way log-hours.js does, and verification left 'pending' for the
// organisers to work through.
//
//   node seed-oupa-hours.js           # dry run: print the plan
//   node seed-oupa-hours.js --insert  # write the rows
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.log("missing SUPABASE_URL / SUPABASE_ANON_KEY in .env");
  process.exit(1);
}
const supabase = createClient(url, key);

const YEAR = 2026;
const MONTH = 10; // October
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_START = `${YEAR}-${String(MONTH).padStart(2, "0")}-01`;
const MONTH_END = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(
  new Date(YEAR, MONTH, 0).getDate(),
).padStart(2, "0")}`;
const INSERT = process.argv.includes("--insert");

function fail(step, error) {
  console.log(`FAIL [${step}]:`, error?.message ?? error);
  process.exit(1);
}

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

// The two weekly slots of a course, as [type, day, start, end] rows.
function courseSlots(course) {
  return [
    [
      "tutorial",
      course.Day_of_tut,
      course.tutor_start_time,
      course.tutor_end_time,
    ],
    ["lab", course.Day_of_lab, course.lab_start_time, course.lab_end_time],
  ];
}

(async () => {
  // 1. Find the user.
  const { data: matches, error: userError } = await supabase
    .from("users")
    .select("id, name, role")
    .ilike("name", "%oupa%");
  if (userError) fail("find-user", userError);
  if (!matches || matches.length === 0)
    fail("find-user", "no user matching 'oupa'");
  if (matches.length > 1) {
    matches.forEach((u) => console.log(`  ${u.id}  ${u.role}  ${u.name}`));
    fail("find-user", "multiple users match 'oupa' (listed above)");
  }
  const user = matches[0];
  console.log(`user: ${user.name} (${user.role}) ${user.id}`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const coursesById = {};
  async function loadCourse(courseId) {
    if (coursesById[courseId] !== undefined) return coursesById[courseId];
    const { data, error } = await supabase
      .from("courses")
      .select(
        "id, course_code, Day_of_tut, tutor_start_time, tutor_end_time, Day_of_lab, lab_start_time, lab_end_time",
      )
      .eq("id", courseId)
      .maybeSingle();
    if (error) fail("load-course", error);
    coursesById[courseId] = data;
    return data;
  }

  // 2. Which sessions may this person log?
  //    Tutors: every scheduled slot of their approved courses.
  //    Volunteers: only the sessions assigned to them to cover.
  const { data: tutorRow } = await supabase
    .from("tutors")
    .select("id, academic_level")
    .eq("id", user.id)
    .maybeSingle();

  const sessions = []; // { course, date, start, end, slotType, taskType }
  if (tutorRow) {
    console.log(`tutor: academic_level=${tutorRow.academic_level}`);
    const { data: prefs, error: prefsError } = await supabase
      .from("tutor_subject_preference")
      .select("course_id, status")
      .eq("tutor_id", user.id);
    if (prefsError) fail("preferences", prefsError);
    const approved = (prefs || []).filter(
      (p) => (p.status || "").toLowerCase() === "approved",
    );
    if (approved.length === 0)
      fail("preferences", "no approved courses for this tutor");
    console.log(
      `approved courses: ${approved.map((p) => p.course_id).join(", ")}`,
    );

    const daysInMonth = new Date(YEAR, MONTH, 0).getDate();
    for (const pref of approved) {
      const course = await loadCourse(pref.course_id);
      if (!course) {
        console.log(`course ${pref.course_id}: not found, skipped`);
        continue;
      }
      for (let d = 1; d <= daysInMonth; d++) {
        const when = new Date(YEAR, MONTH - 1, d);
        if (when > today) continue; // future sessions can't have been attended
        const weekday = DAY_NAMES[when.getDay()];
        const date = `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        for (const [slotType, day, start, end] of courseSlots(course)) {
          if (
            day &&
            day.toLowerCase() === weekday.toLowerCase() &&
            start &&
            end
          ) {
            sessions.push({
              course,
              date,
              start: sliceTime(start),
              end: sliceTime(end),
              slotType,
              taskType: "Tutoring",
            });
          }
        }
      }
    }
  } else {
    const { data: excusals, error: excError } = await supabase
      .from("session_excusals")
      .select("course_id, session_date, session_type")
      .eq("cover_user_id", user.id)
      .gte("session_date", MONTH_START)
      .lte("session_date", MONTH_END);
    if (excError) fail("excusals", excError);
    if (!excusals || excusals.length === 0)
      fail("excusals", "no covering assignments in October");
    for (const ex of excusals) {
      const course = await loadCourse(ex.course_id);
      if (!course) continue;
      const date = String(ex.session_date).slice(0, 10);
      if (new Date(`${date}T00:00:00`) > today) continue;
      const weekday = DAY_NAMES[new Date(`${date}T00:00:00`).getDay()];
      const slot = courseSlots(course).find(
        ([type, day]) =>
          type === ex.session_type &&
          day &&
          day.toLowerCase() === weekday.toLowerCase(),
      );
      if (slot && slot[2] && slot[3]) {
        sessions.push({
          course,
          date,
          start: sliceTime(slot[2]),
          end: sliceTime(slot[3]),
          slotType: slot[0],
          taskType: "Peer support",
        });
      }
    }
  }

  // 3. Skip anything already logged this month.
  const { data: existing, error: existingError } = await supabase
    .from("hour_entries")
    .select("date, course_id, start_time, end_time")
    .eq("user_id", user.id)
    .gte("date", MONTH_START)
    .lte("date", MONTH_END);
  if (existingError) fail("existing", existingError);
  const logged = new Set(
    (existing || []).map(
      (e) =>
        `${String(e.date).slice(0, 10)}|${e.course_id}|${sliceTime(e.start_time)}|${sliceTime(e.end_time)}`,
    ),
  );

  // 4. Build the rows the API would have written.
  const rows = [];
  for (const s of sessions) {
    if (logged.has(`${s.date}|${s.course.id}|${s.start}|${s.end}`)) continue;
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    const minutes = eh * 60 + em - (sh * 60 + sm);
    const hours = Math.round(minutes / 60);
    if (hours <= 0) continue;
    rows.push({
      user_id: user.id,
      date: s.date,
      hours,
      start_time: s.start,
      end_time: s.end,
      task_type: s.taskType,
      subject: s.course.course_code,
      notes: "",
      course_id: s.course.id,
    });
  }

  // 5. Show the plan.
  console.log(`\nplanned entries (${rows.length}):`);
  for (const r of rows) {
    console.log(
      `  ${r.date}  ${r.subject}  ${r.start_time}-${r.end_time}  ${r.hours}h  ${r.task_type}  (${sessions.find((s) => s.date === r.date && s.course.id === r.course_id)?.slotType})`,
    );
  }
  if (rows.length === 0) {
    console.log("nothing to insert");
    return;
  }
  if (!INSERT) {
    console.log("\ndry run — re-run with --insert to write these rows");
    return;
  }

  // 6. Insert and read back.
  const { data: inserted, error: insertError } = await supabase
    .from("hour_entries")
    .insert(rows)
    .select("id, date, subject, hours, verification_status");
  if (insertError) fail("insert", insertError);
  console.log(`\ninserted ${inserted.length} rows, all pending verification:`);
  for (const r of inserted) {
    console.log(
      `  ${r.date}  ${r.subject}  ${r.hours}h  ${r.verification_status}`,
    );
  }
})().catch((err) => fail("unexpected", err));
