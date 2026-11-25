const express = require("express");
const supabase = require("../supabaseClient");

// Mounted at /api/courses/:courseId/diagonals — mergeParams exposes :courseId.
const router = express.Router({ mergeParams: true });

// A large course can be split into diagonals (student groups) labelled
// A, B, C… Only the count is stored on the course (courses.diagonal_count);
// each approved tutor / student volunteer then carries the label of the
// diagonal they're in (tutor_subject_preference.diagonal and
// course_volunteers.diagonal). Capped at 26 so every label is one letter.
const MAX_DIAGONALS = 26;

function diagonalLabels(count) {
  return Array.from({ length: count || 0 }, (_, i) =>
    String.fromCharCode(65 + i),
  );
}

// The two kinds of people that can be placed in a diagonal, and where each
// one lives.
const MEMBER_KINDS = {
  tutor: {
    table: "tutor_subject_preference",
    select: "id, tutor_id, diagonal, status, tutors(name, email)",
    toMember: (row) => ({
      id: row.id,
      user_id: row.tutor_id,
      name: row.tutors?.name || row.Tutor_name || "Unknown",
      email: row.tutors?.email || "",
      diagonal: row.diagonal ?? null,
    }),
  },
  volunteer: {
    table: "course_volunteers",
    select: "id, user_id, diagonal, status, users(name, email)",
    toMember: (row) => ({
      id: row.id,
      user_id: row.user_id,
      name: row.users?.name || "Unknown",
      email: row.users?.email || "",
      diagonal: row.diagonal ?? null,
    }),
  },
};

function parseCourseId(req) {
  const id = Number(req.params.courseId);
  return Number.isInteger(id) ? id : null;
}

async function loadCourse(courseId) {
  return supabase
    .from("courses")
    .select("id, course_code, diagonal_count")
    .eq("id", courseId)
    .maybeSingle();
}

// Approved members of one kind, sorted by name so an even split is stable
// and predictable (the same people land in the same diagonal each time).
async function loadApprovedMembers(kind, courseId) {
  const { table, select, toMember } = MEMBER_KINDS[kind];
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq("course_id", courseId)
    .eq("status", "approved");
  if (error) return { error };
  const members = (data || [])
    .map(toMember)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { members };
}

// Splits members into `labels.length` contiguous, near-equal chunks — the
// first (members % n) diagonals get one extra person. Returns
// { A: [ids…], B: [ids…], … }.
function splitEvenly(members, labels) {
  const groups = {};
  const base = Math.floor(members.length / labels.length);
  const extra = members.length % labels.length;
  let cursor = 0;
  labels.forEach((label, i) => {
    const size = base + (i < extra ? 1 : 0);
    groups[label] = members.slice(cursor, cursor + size).map((m) => m.id);
    cursor += size;
  });
  return groups;
}

// GET /api/courses/:courseId/diagonals — each diagonal with the approved
// tutors and volunteers in it, plus whoever hasn't been placed yet.
router.get("/", async (req, res) => {
  const courseId = parseCourseId(req);
  if (courseId === null) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const { data: course, error: courseError } = await loadCourse(courseId);
  if (courseError) return res.status(500).json({ error: courseError.message });
  if (!course) return res.status(404).json({ error: "Course not found" });

  const labels = diagonalLabels(course.diagonal_count);

  const [tutorResult, volunteerResult] = await Promise.all([
    loadApprovedMembers("tutor", courseId),
    loadApprovedMembers("volunteer", courseId),
  ]);
  const loadError = tutorResult.error || volunteerResult.error;
  if (loadError) return res.status(500).json({ error: loadError.message });

  const validLabels = new Set(labels);
  const diagonals = labels.map((label) => ({
    label,
    tutors: tutorResult.members.filter((m) => m.diagonal === label),
    volunteers: volunteerResult.members.filter((m) => m.diagonal === label),
  }));

  res.json({
    course_id: courseId,
    diagonal_count: course.diagonal_count ?? 0,
    diagonals,
    unassigned: {
      tutors: tutorResult.members.filter((m) => !validLabels.has(m.diagonal)),
      volunteers: volunteerResult.members.filter(
        (m) => !validLabels.has(m.diagonal),
      ),
    },
  });
});

// POST /api/courses/:courseId/diagonals/split — spreads every approved tutor
// and volunteer evenly across the course's diagonals, replacing whatever
// placement they had before. Body (optional): { kinds: ["tutor", "volunteer"] }
// to only re-split one of the two groups.
router.post("/split", async (req, res) => {
  const courseId = parseCourseId(req);
  if (courseId === null) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const requestedKinds = req.body?.kinds ?? Object.keys(MEMBER_KINDS);
  if (
    !Array.isArray(requestedKinds) ||
    requestedKinds.length === 0 ||
    requestedKinds.some((k) => !MEMBER_KINDS[k])
  ) {
    return res
      .status(400)
      .json({ error: 'kinds must be a list of "tutor" and/or "volunteer"' });
  }

  const { data: course, error: courseError } = await loadCourse(courseId);
  if (courseError) return res.status(500).json({ error: courseError.message });
  if (!course) return res.status(404).json({ error: "Course not found" });

  const labels = diagonalLabels(course.diagonal_count);
  if (labels.length === 0) {
    return res.status(409).json({
      error: `${course.course_code} isn't split into diagonals — turn on diagonals in Edit course first`,
    });
  }

  for (const kind of requestedKinds) {
    const { members, error } = await loadApprovedMembers(kind, courseId);
    if (error) return res.status(500).json({ error: error.message });

    const groups = splitEvenly(members, labels);
    for (const label of labels) {
      if (groups[label].length === 0) continue;
      const { error: updateError } = await supabase
        .from(MEMBER_KINDS[kind].table)
        .update({ diagonal: label })
        .in("id", groups[label]);
      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }
    }
  }

  res.json({ ok: true, diagonal_count: labels.length });
});

// PATCH /api/courses/:courseId/diagonals/members — move one approved tutor
// or volunteer into a diagonal. Body: { kind: "tutor" | "volunteer", id,
// diagonal: "A".."Z" | null } — null takes them out of every diagonal.
router.patch("/members", async (req, res) => {
  const courseId = parseCourseId(req);
  if (courseId === null) {
    return res.status(400).json({ error: "Invalid course id" });
  }

  const { kind, id, diagonal } = req.body ?? {};
  if (!MEMBER_KINDS[kind]) {
    return res
      .status(400)
      .json({ error: 'kind must be "tutor" or "volunteer"' });
  }
  if (id === undefined || id === null || id === "") {
    return res.status(400).json({ error: "id is required" });
  }

  const { data: course, error: courseError } = await loadCourse(courseId);
  if (courseError) return res.status(500).json({ error: courseError.message });
  if (!course) return res.status(404).json({ error: "Course not found" });

  const labels = diagonalLabels(course.diagonal_count);
  if (diagonal !== null && !labels.includes(diagonal)) {
    return res.status(400).json({
      error:
        labels.length === 0
          ? `${course.course_code} isn't split into diagonals`
          : `diagonal must be one of ${labels.join(", ")} (or null)`,
    });
  }

  const { table } = MEMBER_KINDS[kind];
  const { data: row, error: rowError } = await supabase
    .from(table)
    .select("id, course_id, status")
    .eq("id", id)
    .maybeSingle();
  if (rowError) return res.status(500).json({ error: rowError.message });
  if (!row || row.course_id !== courseId) {
    return res.status(404).json({ error: `No such ${kind} on this course` });
  }
  if ((row.status || "").toLowerCase() !== "approved") {
    return res.status(409).json({
      error: `Only approved ${kind}s can be placed in a diagonal`,
    });
  }

  const { data, error } = await supabase
    .from(table)
    .update({ diagonal })
    .eq("id", id)
    .select("id, diagonal")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

module.exports = router;
module.exports.MAX_DIAGONALS = MAX_DIAGONALS;
module.exports.diagonalLabels = diagonalLabels;
module.exports.splitEvenly = splitEvenly;
