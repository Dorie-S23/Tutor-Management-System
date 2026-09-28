const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// Public, read-only course catalogue for external consumers. Deliberately a
// separate projection from /api/courses (which returns select("*"), including
// internal-only fields like budget, min_mark and the assigned-tutor counter):
// only the columns needed for the public shape are ever fetched, so those
// fields can't leak even if the shaping below changes.
const PUBLIC_COURSE_COLUMNS =
  "course_code, course_name, department, tutors_needed, no_of_tutors_assigned, Day_of_tut, Day_of_lab";

// Courses change rarely (they're set up per term), so letting edges and
// clients cache responses for five minutes keeps repeated external traffic
// off the API — see the Performance item in the final submission rubric.
const PUBLIC_CACHE_HEADER = "public, max-age=300, s-maxage=300";

// The day fields are the app's own "does this course have a tutorial/lab"
// signal: the Add/Edit Course form always sets day, times and venue together
// (see parseSessionGroup in courses.js), so a non-null day means the session
// exists. openings is needed-minus-assigned, clamped at zero so an
// over-assigned course never reports a negative count.
function toPublicCourse(row) {
  const sessionTypes = [];
  if (row.Day_of_tut) sessionTypes.push("tutorial");
  if (row.Day_of_lab) sessionTypes.push("lab");

  const assigned = row.no_of_tutors_assigned ?? 0;
  const openings = Math.max(0, (row.tutors_needed ?? 0) - assigned);

  return {
    course_code: row.course_code,
    course_name: row.course_name,
    department: row.department,
    session_types: sessionTypes,
    openings,
  };
}

// GET /api/v1 — discovery document: what this API is and what it offers,
// so an external consumer landing on the base path isn't guessing.
router.get("/", (req, res) => {
  res.set("Cache-Control", PUBLIC_CACHE_HEADER);
  res.json({
    name: "TutorX public API",
    description:
      "Read-only public course catalogue for the Wits School of Computer Science and Applied Mathematics tutoring programme.",
    version: "v1",
    documentation:
      "https://tutorx-documentation.devden.workers.dev/docs/public-api",
    resources: {
      courses: "/api/v1/courses",
    },
  });
});

// GET /api/v1/courses — every course, optionally filtered by department
// (exact, case-insensitive) or session_type (tutorial or lab). Filters are
// applied after shaping because session presence isn't a column of its own.
router.get("/courses", async (req, res) => {
  const { department, session_type } = req.query;

  if (
    session_type != null &&
    session_type !== "tutorial" &&
    session_type !== "lab"
  ) {
    return res
      .status(400)
      .json({ error: 'session_type must be either "tutorial" or "lab"' });
  }

  const { data, error } = await supabase
    .from("courses")
    .select(PUBLIC_COURSE_COLUMNS)
    .order("course_code", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  let courses = (data || []).map(toPublicCourse);

  const departmentFilter =
    typeof department === "string" ? department.trim().toLowerCase() : "";
  if (departmentFilter) {
    courses = courses.filter(
      (course) => (course.department || "").toLowerCase() === departmentFilter,
    );
  }
  if (session_type) {
    courses = courses.filter((course) =>
      course.session_types.includes(session_type),
    );
  }

  res.set("Cache-Control", PUBLIC_CACHE_HEADER);
  res.json({ data: courses, meta: { count: courses.length } });
});

// GET /api/v1/courses/:code — one course, addressed by its unique course
// code rather than the internal numeric id. Matching is case-insensitive:
// stored casing isn't enforced and the live catalogue contains both
// "COMS1016A"-style and lower-cased codes, and the DB's unique constraint is
// case-sensitive, so an exact-case match wins if a case-variant duplicate
// ever exists. The catalogue is tens of rows, so matching in memory beats a
// wildcard LIKE query (which would also need escaping of % and _ in input).
router.get("/courses/:code", async (req, res) => {
  const requested = req.params.code.trim();

  const { data, error } = await supabase
    .from("courses")
    .select(PUBLIC_COURSE_COLUMNS);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const rows = data || [];
  const course =
    rows.find((row) => row.course_code === requested) ||
    rows.find(
      (row) =>
        String(row.course_code).toLowerCase() === requested.toLowerCase(),
    );

  if (!course) {
    return res.status(404).json({ error: "Course not found" });
  }

  res.set("Cache-Control", PUBLIC_CACHE_HEADER);
  res.json({ data: toPublicCourse(course) });
});

// Everything under /api/v1 is read-only, so a non-GET on a known path gets
// an explicit JSON 405 with an Allow header rather than silently falling
// through to a bare 404.
function methodNotAllowed(req, res) {
  res.set("Allow", "GET, HEAD");
  res
    .status(405)
    .json({ error: "This API is read-only — only GET is supported" });
}

router.all("/", methodNotAllowed);
router.all("/courses", methodNotAllowed);
router.all("/courses/:code", methodNotAllowed);

module.exports = router;
