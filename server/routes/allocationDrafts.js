const express = require("express");
const supabase = require("../supabaseClient");
const { recordAudit } = require("../utils/auditLog");
const { DAY_NAMES } = require("../dayNames");

const router = express.Router();

// Small, self-contained duplicates of tutorApplications.js's own
// toMinutes/overlaps helpers — deliberately not shared, so this route never
// risks changing the behaviour of that already-tested endpoint.
function toMinutes(timeStr) {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Used only as a soft ranking tie-break (see auto-allocate below), not a
// hard gate — the manual PATCH /:id approval doesn't block on clash either,
// it's informational there too. busy.day_of_week is 0-6 (see dayNames.js);
// course.Day_of_tut is the same day spelled out ("Monday"), so it's mapped
// through DAY_NAMES before comparing.
function courseHasClash(course, busyTimes, otherApprovedCourses) {
  const courseDay = course.Day_of_tut;
  const courseStart = toMinutes(course.tutor_start_time);
  const courseEnd = toMinutes(course.tutor_end_time);
  if (!courseDay || courseStart == null || courseEnd == null) return false;

  for (const busy of busyTimes) {
    if (DAY_NAMES[busy.day_of_week] !== courseDay) continue;
    const busyStart = toMinutes(busy.start_time);
    const busyEnd = toMinutes(busy.end_time);
    if (
      busyStart != null &&
      busyEnd != null &&
      overlaps(courseStart, courseEnd, busyStart, busyEnd)
    ) {
      return true;
    }
  }

  for (const other of otherApprovedCourses) {
    if (!other || other.Day_of_tut !== courseDay) continue;
    const otherStart = toMinutes(other.tutor_start_time);
    const otherEnd = toMinutes(other.tutor_end_time);
    if (
      otherStart != null &&
      otherEnd != null &&
      overlaps(courseStart, courseEnd, otherStart, otherEnd)
    ) {
      return true;
    }
  }

  return false;
}

// Attaches course_code/course_name and tutor name/email to a set of
// allocation_draft_assignments rows, which only store bare tutor_id/
// course_id — one lookup per referenced table rather than one query per
// assignment.
async function enrichAssignments(assignments) {
  const courseIds = [...new Set(assignments.map((a) => a.course_id))];
  const tutorIds = [...new Set(assignments.map((a) => a.tutor_id))];

  const [{ data: courses }, { data: tutors }] = await Promise.all([
    courseIds.length
      ? supabase
          .from("courses")
          .select("id, course_code, course_name")
          .in("id", courseIds)
      : Promise.resolve({ data: [] }),
    tutorIds.length
      ? supabase.from("tutors").select("id, name, email").in("id", tutorIds)
      : Promise.resolve({ data: [] }),
  ]);

  const courseById = new Map((courses || []).map((c) => [c.id, c]));
  const tutorById = new Map((tutors || []).map((t) => [t.id, t]));

  return assignments.map((a) => ({
    ...a,
    course: courseById.get(a.course_id) || null,
    tutor: tutorById.get(a.tutor_id) || null,
  }));
}

// POST /api/allocation-drafts/auto-allocate — proposes tutor assignments for
// every course with open slots, in one pass across the whole school.
//
// A pending application is even considered if: the tutor's mark clears the
// course's bar, they're marked available, the application isn't locked (an
// organiser's manual pin that no bulk/auto action should touch), and
// approving it wouldn't push the tutor over their weekly hour cap — that
// last one is a running total across this whole run, not just this course,
// so a tutor proposed for two courses in the same pass can't blow their cap
// across the two even though each alone would fit. Mark and availability
// are hard requirements (matching the mark-only bar the manual application
// flow already enforces); hour cap is a hard rule too, mirroring the manual
// PATCH /:id approval, which blocks on it unless an organiser overrides it —
// auto-allocate has no such override step, so it just skips those instead.
// A timetable clash is a softer signal (the manual approval doesn't block on
// it either, only shows it) — it's used to break ties, preferring a
// non-clashing candidate over a clashing one at the same mark.
//
// Nothing is applied yet — this writes a draft for an organiser to review
// and publish. Every eligible-but-not-picked applicant is still reported
// back (not persisted) with the reason it didn't make the cut, so the
// review UI can show why, not just who.
router.post("/auto-allocate", async (req, res) => {
  const { organiserId, name } = req.body ?? {};
  if (!organiserId) {
    return res.status(400).json({ error: "organiserId is required" });
  }

  const { data: courses, error: coursesError } = await supabase
    .from("courses")
    .select(
      "id, course_code, course_name, min_mark, tutors_needed, no_of_tutors_assigned, hours_per_week, Day_of_tut, tutor_start_time, tutor_end_time",
    );
  if (coursesError)
    return res.status(500).json({ error: coursesError.message });

  const { data: applications, error: applicationsError } = await supabase
    .from("tutor_subject_preference")
    .select(
      "id, tutor_id, course_id, tutor_mark, Availability, Tutor_name, locked",
    )
    .eq("status", "pending");
  if (applicationsError)
    return res.status(500).json({ error: applicationsError.message });

  const candidateTutorIds = [
    ...new Set(applications.filter((a) => !a.locked).map((a) => a.tutor_id)),
  ];

  const [
    { data: tutors, error: tutorsError },
    { data: otherApprovals, error: otherApprovalsError },
    { data: busyTimeRows, error: busyTimesError },
  ] = await Promise.all([
    candidateTutorIds.length
      ? supabase
          .from("tutors")
          .select("id, weekly_hour_cap")
          .in("id", candidateTutorIds)
      : Promise.resolve({ data: [] }),
    candidateTutorIds.length
      ? supabase
          .from("tutor_subject_preference")
          .select("tutor_id, courses(hours_per_week)")
          .eq("status", "approved")
          .in("tutor_id", candidateTutorIds)
      : Promise.resolve({ data: [] }),
    candidateTutorIds.length
      ? supabase
          .from("tutor_busy_times")
          .select("tutor_id, day_of_week, start_time, end_time")
          .in("tutor_id", candidateTutorIds)
      : Promise.resolve({ data: [] }),
  ]);
  if (tutorsError) return res.status(500).json({ error: tutorsError.message });
  if (otherApprovalsError)
    return res.status(500).json({ error: otherApprovalsError.message });
  if (busyTimesError)
    return res.status(500).json({ error: busyTimesError.message });

  const hourCapByTutor = new Map(
    (tutors || []).map((t) => [t.id, t.weekly_hour_cap]),
  );

  // Running total, mutated as picks are made below so a tutor proposed for
  // more than one course in this same run is checked cumulatively.
  const projectedHoursByTutor = new Map();
  (otherApprovals || []).forEach((row) => {
    const hours = row.courses?.hours_per_week || 0;
    projectedHoursByTutor.set(
      row.tutor_id,
      (projectedHoursByTutor.get(row.tutor_id) || 0) + hours,
    );
  });

  const busyTimesByTutor = new Map();
  (busyTimeRows || []).forEach((row) => {
    if (!busyTimesByTutor.has(row.tutor_id))
      busyTimesByTutor.set(row.tutor_id, []);
    busyTimesByTutor.get(row.tutor_id).push(row);
  });

  function wouldExceedCap(tutorId, course) {
    const cap = hourCapByTutor.get(tutorId);
    if (cap == null) return false;
    const projected =
      (projectedHoursByTutor.get(tutorId) || 0) + (course.hours_per_week || 0);
    return projected > cap;
  }

  const proposals = [];
  const skipped = [];

  for (const course of courses) {
    const remainingSlots =
      (course.tutors_needed ?? 0) - (course.no_of_tutors_assigned ?? 0);
    if (remainingSlots <= 0) continue;

    const courseApplicants = applications.filter(
      (app) => app.course_id === course.id,
    );

    const eligible = [];
    for (const app of courseApplicants) {
      if (app.locked) {
        skipped.push({
          tutorId: app.tutor_id,
          courseId: course.id,
          tutorName: app.Tutor_name,
          reason: "This application is locked — left for manual review",
        });
        continue;
      }
      if (
        typeof app.tutor_mark !== "number" ||
        app.tutor_mark < course.min_mark
      ) {
        continue; // below the mark bar — not a real candidate, not worth reporting as "skipped"
      }
      if (app.Availability !== true) {
        continue; // not available — same as above
      }
      if (wouldExceedCap(app.tutor_id, course)) {
        const cap = hourCapByTutor.get(app.tutor_id);
        skipped.push({
          tutorId: app.tutor_id,
          courseId: course.id,
          tutorName: app.Tutor_name,
          reason: `Would put this tutor over their ${cap} hr/week cap — skipped`,
        });
        continue;
      }
      eligible.push({
        ...app,
        clash: courseHasClash(
          course,
          busyTimesByTutor.get(app.tutor_id) || [],
          [],
        ),
      });
    }

    if (eligible.length === 0) continue;

    // Mark dominates, same as the manual ranking display (mark is worth up
    // to 100 of its 160-point score, clash only 20) — clash only decides it
    // between candidates already tied on mark.
    eligible.sort(
      (a, b) =>
        b.tutor_mark - a.tutor_mark ||
        Number(a.clash) - Number(b.clash) ||
        (a.id > b.id ? 1 : -1),
    );

    const picked = eligible.slice(0, remainingSlots);
    const passedOver = eligible.slice(remainingSlots);

    picked.forEach((app, index) => {
      const clashNote = app.clash ? ", has a timetable clash" : "";
      const explanation =
        eligible.length <= remainingSlots
          ? `Only eligible applicant for this slot (mark ${app.tutor_mark}, course minimum ${course.min_mark}${clashNote})`
          : `Ranked #${index + 1} of ${eligible.length} eligible applicants by mark (${app.tutor_mark}${clashNote})`;

      proposals.push({
        tutor_id: app.tutor_id,
        course_id: course.id,
        explanation,
        locked: false,
      });

      projectedHoursByTutor.set(
        app.tutor_id,
        (projectedHoursByTutor.get(app.tutor_id) || 0) +
          (course.hours_per_week || 0),
      );
    });

    passedOver.forEach((app, index) => {
      skipped.push({
        tutorId: app.tutor_id,
        courseId: course.id,
        tutorName: app.Tutor_name,
        reason: `Ranked #${remainingSlots + index + 1} of ${eligible.length} eligible applicants — the ${remainingSlots} open slot${remainingSlots === 1 ? "" : "s"} went to higher-ranked applicants`,
      });
    });
  }

  if (proposals.length === 0) {
    return res.status(200).json({
      draft: null,
      assignments: [],
      skipped,
      message:
        "No courses currently have both open slots and eligible applicants.",
    });
  }

  const { data: draft, error: draftError } = await supabase
    .from("allocation_drafts")
    .insert({
      name:
        name?.trim() ||
        `Whole-school auto allocation — ${new Date().toISOString()}`,
      created_by: organiserId,
      status: "draft",
    })
    .select()
    .single();
  if (draftError) return res.status(500).json({ error: draftError.message });

  const { data: assignments, error: assignmentsError } = await supabase
    .from("allocation_draft_assignments")
    .insert(proposals.map((p) => ({ ...p, draft_id: draft.id })))
    .select();
  if (assignmentsError)
    return res.status(500).json({ error: assignmentsError.message });

  res.status(201).json({
    draft,
    assignments: await enrichAssignments(assignments),
    skipped,
  });
});

// GET /api/allocation-drafts?status=draft|published|reverted
router.get("/", async (req, res) => {
  const { status } = req.query;

  let query = supabase
    .from("allocation_drafts")
    .select("*")
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);

  const { data: drafts, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const draftIds = drafts.map((d) => d.id);
  const { data: allAssignments } = draftIds.length
    ? await supabase
        .from("allocation_draft_assignments")
        .select("draft_id")
        .in("draft_id", draftIds)
    : { data: [] };

  const countByDraft = {};
  (allAssignments || []).forEach((a) => {
    countByDraft[a.draft_id] = (countByDraft[a.draft_id] || 0) + 1;
  });

  res.json(
    drafts.map((d) => ({ ...d, assignmentCount: countByDraft[d.id] || 0 })),
  );
});

// GET /api/allocation-drafts/:id — a draft plus its proposed/applied assignments
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid draft id" });
  }

  const { data: draft, error: draftError } = await supabase
    .from("allocation_drafts")
    .select("*")
    .eq("id", id)
    .single();
  if (draftError || !draft) {
    return res.status(404).json({ error: "Draft not found" });
  }

  const { data: assignments, error: assignmentsError } = await supabase
    .from("allocation_draft_assignments")
    .select("*")
    .eq("draft_id", id);
  if (assignmentsError)
    return res.status(500).json({ error: assignmentsError.message });

  res.json({ draft, assignments: await enrichAssignments(assignments) });
});

// GET /api/allocation-drafts/:id/compare — a dry run of publish. Runs the
// exact same per-assignment checks POST /:id/publish runs (same order, same
// reason strings) but writes nothing, so an organiser holding an old draft
// can see which proposals would still land today — and which the world has
// moved on from since the draft was proposed — before committing.
//
// Because publish applies assignments one at a time, a draft's own rows
// interact: two proposals for the same course compete for the same last
// slot, and two proposals for the same tutor stack towards their hour cap.
// The simulation below mirrors that sequencing, so what compare says here is
// what publish would actually do if run in the same moment.
router.get("/:id/compare", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid draft id" });
  }

  const { data: draft, error: draftError } = await supabase
    .from("allocation_drafts")
    .select("*")
    .eq("id", id)
    .single();
  if (draftError || !draft) {
    return res.status(404).json({ error: "Draft not found" });
  }

  const { data: assignments, error: assignmentsError } = await supabase
    .from("allocation_draft_assignments")
    .select("*")
    .eq("draft_id", id);
  if (assignmentsError)
    return res.status(500).json({ error: assignmentsError.message });

  const tutorIds = [...new Set(assignments.map((a) => a.tutor_id))];
  const courseIds = [...new Set(assignments.map((a) => a.course_id))];

  const [
    { data: courses, error: coursesError },
    { data: tutors, error: tutorsError },
    { data: applications, error: applicationsError },
  ] = await Promise.all([
    courseIds.length
      ? supabase
          .from("courses")
          .select(
            "id, course_code, course_name, tutors_needed, no_of_tutors_assigned, hours_per_week",
          )
          .in("id", courseIds)
      : Promise.resolve({ data: [] }),
    tutorIds.length
      ? supabase
          .from("tutors")
          .select("id, name, email, weekly_hour_cap")
          .in("id", tutorIds)
      : Promise.resolve({ data: [] }),
    tutorIds.length
      ? supabase
          .from("tutor_subject_preference")
          .select("id, tutor_id, course_id, status, courses(hours_per_week)")
          .in("tutor_id", tutorIds)
      : Promise.resolve({ data: [] }),
  ]);
  if (coursesError)
    return res.status(500).json({ error: coursesError.message });
  if (tutorsError) return res.status(500).json({ error: tutorsError.message });
  if (applicationsError)
    return res.status(500).json({ error: applicationsError.message });

  const courseById = new Map((courses || []).map((c) => [c.id, c]));
  const tutorById = new Map((tutors || []).map((t) => [t.id, t]));
  const applicationByTutorCourse = new Map(
    (applications || []).map((app) => [
      `${app.tutor_id}|${app.course_id}`,
      app,
    ]),
  );

  // Approved hours kept as per-course rows (not pre-summed) so each check can
  // exclude the one course publish's own query excludes (.neq course_id).
  const approvedRowsByTutor = new Map();
  (applications || [])
    .filter((app) => app.status === "approved")
    .forEach((app) => {
      if (!approvedRowsByTutor.has(app.tutor_id))
        approvedRowsByTutor.set(app.tutor_id, []);
      approvedRowsByTutor.get(app.tutor_id).push(app);
    });

  // Running state of the simulated publish: the course counts it would bump
  // and the hours it would add to each tutor.
  const assignedByCourse = new Map(
    (courses || []).map((c) => [c.id, c.no_of_tutors_assigned ?? 0]),
  );
  const draftHoursByTutor = new Map();

  const rows = assignments.map((assignment) => {
    const application = applicationByTutorCourse.get(
      `${assignment.tutor_id}|${assignment.course_id}`,
    );

    if (!application || application.status !== "pending") {
      return {
        ...assignment,
        willApply: false,
        reason: "no longer a pending application",
        currentStatus: application?.status ?? null,
        projectedHours: null,
        cap: null,
      };
    }

    const course = courseById.get(assignment.course_id);
    if (!course) {
      return {
        ...assignment,
        willApply: false,
        reason: "course not found",
        currentStatus: application.status,
        projectedHours: null,
        cap: null,
      };
    }

    const next = (assignedByCourse.get(course.id) ?? 0) + 1;
    if (next > (course.tutors_needed ?? 0)) {
      return {
        ...assignment,
        willApply: false,
        reason: "course is now full",
        currentStatus: application.status,
        projectedHours: null,
        cap: null,
      };
    }

    const tutor = tutorById.get(assignment.tutor_id);
    if (!tutor) {
      return {
        ...assignment,
        willApply: false,
        reason: "tutor not found",
        currentStatus: application.status,
        projectedHours: null,
        cap: null,
      };
    }

    const courseHours = course.hours_per_week || 0;
    let projectedHours = null;
    if (tutor.weekly_hour_cap != null) {
      const currentAssignedHours = (approvedRowsByTutor.get(tutor.id) || [])
        .filter((app) => app.course_id !== assignment.course_id)
        .reduce((sum, app) => sum + (app.courses?.hours_per_week || 0), 0);
      projectedHours =
        currentAssignedHours +
        (draftHoursByTutor.get(tutor.id) || 0) +
        courseHours;
      if (projectedHours > tutor.weekly_hour_cap) {
        return {
          ...assignment,
          willApply: false,
          reason: `would put the tutor at ${projectedHours}/${tutor.weekly_hour_cap} hrs/week, over their cap`,
          currentStatus: application.status,
          projectedHours,
          cap: tutor.weekly_hour_cap,
        };
      }
    }

    // This one would land — advance the simulation the way publish would.
    assignedByCourse.set(course.id, next);
    draftHoursByTutor.set(
      tutor.id,
      (draftHoursByTutor.get(tutor.id) || 0) + courseHours,
    );

    return {
      ...assignment,
      willApply: true,
      reason: null,
      currentStatus: application.status,
      projectedHours,
      cap: tutor.weekly_hour_cap ?? null,
    };
  });

  const willApply = rows.filter((r) => r.willApply).length;

  res.json({
    draft,
    summary: { willApply, cannotApply: rows.length - willApply },
    assignments: await enrichAssignments(rows),
  });
});

// POST /api/allocation-drafts/:id/publish
//
// Applies a draft's assignments for real: each one approves the matching
// pending application and bumps its course's assigned-tutor count, the same
// as a manual approve would. `excludeAssignmentIds` lets the organiser drop
// specific proposed rows before publishing rather than all-or-nothing.
// Anything that no longer applies cleanly (the application isn't pending
// any more, or the course filled up in the meantime) is skipped rather than
// failing the whole publish.
//
// The exact pre-publish state of every application this touches is written
// into the audit log's `before` field under one 'published' entry for this
// draft — that's what restore reads to know what to undo, so no separate
// snapshot table is needed.
router.post("/:id/publish", async (req, res) => {
  const { organiserId, excludeAssignmentIds } = req.body ?? {};
  if (!organiserId) {
    return res.status(400).json({ error: "organiserId is required" });
  }
  const excluded = new Set((excludeAssignmentIds || []).map(String));

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid draft id" });
  }

  const { data: draft, error: draftError } = await supabase
    .from("allocation_drafts")
    .select("*")
    .eq("id", id)
    .single();
  if (draftError || !draft) {
    return res.status(404).json({ error: "Draft not found" });
  }
  if (draft.status !== "draft") {
    return res
      .status(409)
      .json({ error: `This draft is already ${draft.status}` });
  }

  const { data: assignments, error: assignmentsError } = await supabase
    .from("allocation_draft_assignments")
    .select("*")
    .eq("draft_id", id);
  if (assignmentsError)
    return res.status(500).json({ error: assignmentsError.message });

  const results = [];
  const appliedSnapshots = [];

  for (const assignment of assignments) {
    if (excluded.has(String(assignment.id))) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: "excluded",
      });
      continue;
    }

    const { data: application, error: applicationError } = await supabase
      .from("tutor_subject_preference")
      .select("id, status, course_id, tutor_id")
      .eq("tutor_id", assignment.tutor_id)
      .eq("course_id", assignment.course_id)
      .maybeSingle();

    if (applicationError || !application || application.status !== "pending") {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: "no longer a pending application",
      });
      continue;
    }

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned, tutors_needed, hours_per_week")
      .eq("id", assignment.course_id)
      .single();
    if (courseError || !course) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: "course not found",
      });
      continue;
    }

    const next = (course.no_of_tutors_assigned ?? 0) + 1;
    if (next > course.tutors_needed) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: "course is now full",
      });
      continue;
    }

    // Re-checked here too (auto-allocate already screened for this when the
    // draft was proposed) since time may have passed and other approvals
    // may have landed since — same rule the manual PATCH /:id approval
    // enforces, just with no override step available here.
    const { data: tutor, error: tutorError } = await supabase
      .from("tutors")
      .select("weekly_hour_cap")
      .eq("id", assignment.tutor_id)
      .single();
    if (tutorError || !tutor) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: "tutor not found",
      });
      continue;
    }
    if (tutor.weekly_hour_cap != null) {
      const { data: otherApprovals, error: otherApprovalsError } =
        await supabase
          .from("tutor_subject_preference")
          .select("courses(hours_per_week)")
          .eq("tutor_id", assignment.tutor_id)
          .eq("status", "approved")
          .neq("course_id", assignment.course_id);
      if (otherApprovalsError) {
        results.push({
          assignmentId: assignment.id,
          success: false,
          reason: otherApprovalsError.message,
        });
        continue;
      }
      const currentAssignedHours = (otherApprovals || []).reduce(
        (sum, a) => sum + (a.courses?.hours_per_week || 0),
        0,
      );
      const projectedHours =
        currentAssignedHours + (course.hours_per_week || 0);
      if (projectedHours > tutor.weekly_hour_cap) {
        results.push({
          assignmentId: assignment.id,
          success: false,
          reason: `would put the tutor at ${projectedHours}/${tutor.weekly_hour_cap} hrs/week, over their cap`,
        });
        continue;
      }
    }

    const { error: bumpError } = await supabase
      .from("courses")
      .update({ no_of_tutors_assigned: next })
      .eq("id", assignment.course_id);
    if (bumpError) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: bumpError.message,
      });
      continue;
    }

    const { error: updateError } = await supabase
      .from("tutor_subject_preference")
      .update({ status: "approved" })
      .eq("id", application.id);
    if (updateError) {
      results.push({
        assignmentId: assignment.id,
        success: false,
        reason: updateError.message,
      });
      continue;
    }

    appliedSnapshots.push({
      applicationId: application.id,
      courseId: assignment.course_id,
      previousStatus: application.status,
    });

    await recordAudit({
      entityType: "tutor_subject_preference",
      entityId: application.id,
      action: "approved",
      actorId: organiserId,
      before: { status: application.status },
      after: {
        status: "approved",
        via: "auto-allocate-publish",
        draftId: draft.id,
      },
    });

    results.push({ assignmentId: assignment.id, success: true });
  }

  const { data: publishedDraft, error: publishError } = await supabase
    .from("allocation_drafts")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", draft.id)
    .select()
    .single();
  if (publishError)
    return res.status(500).json({ error: publishError.message });

  // The restore mechanism's only source of truth: without this entry,
  // there's nothing for /restore to undo.
  await recordAudit({
    entityType: "allocation_draft",
    entityId: draft.id,
    action: "published",
    actorId: organiserId,
    before: { assignments: appliedSnapshots },
    after: { status: "published" },
  });

  res.json({ draft: publishedDraft, results });
});

// POST /api/allocation-drafts/:id/restore — undoes a published draft: every
// application it approved goes back to its pre-publish status, and the
// course's assigned-tutor count is decremented to match, mirroring a manual
// withdrawal. Reads the snapshot recorded in the audit log when the draft
// was published, so a draft can only be restored once (there's exactly one
// 'published' entry to read, and restoring flips the draft to 'reverted').
router.post("/:id/restore", async (req, res) => {
  const { organiserId } = req.body ?? {};
  if (!organiserId) {
    return res.status(400).json({ error: "organiserId is required" });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid draft id" });
  }

  const { data: draft, error: draftError } = await supabase
    .from("allocation_drafts")
    .select("*")
    .eq("id", id)
    .single();
  if (draftError || !draft) {
    return res.status(404).json({ error: "Draft not found" });
  }
  if (draft.status !== "published") {
    return res.status(409).json({
      error: `Only a published draft can be restored (this one is ${draft.status})`,
    });
  }

  const { data: publishEntries, error: auditError } = await supabase
    .from("audit_log")
    .select("before")
    .eq("entity_type", "allocation_draft")
    .eq("entity_id", String(draft.id))
    .eq("action", "published")
    .order("created_at", { ascending: false })
    .limit(1);
  if (auditError) return res.status(500).json({ error: auditError.message });

  const snapshot = publishEntries?.[0]?.before?.assignments;
  if (!snapshot || snapshot.length === 0) {
    return res.status(409).json({
      error: "No publish record found for this draft — nothing to restore",
    });
  }

  const results = [];

  for (const entry of snapshot) {
    const { data: application, error: applicationError } = await supabase
      .from("tutor_subject_preference")
      .select("id, status, course_id")
      .eq("id", entry.applicationId)
      .maybeSingle();

    if (applicationError || !application || application.status !== "approved") {
      results.push({
        applicationId: entry.applicationId,
        success: false,
        reason: "no longer approved — left as-is",
      });
      continue;
    }

    const { data: course } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned")
      .eq("id", application.course_id)
      .single();

    const { error: bumpError } = await supabase
      .from("courses")
      .update({
        no_of_tutors_assigned: Math.max(
          (course?.no_of_tutors_assigned ?? 0) - 1,
          0,
        ),
      })
      .eq("id", application.course_id);
    if (bumpError) {
      results.push({
        applicationId: entry.applicationId,
        success: false,
        reason: bumpError.message,
      });
      continue;
    }

    const { error: updateError } = await supabase
      .from("tutor_subject_preference")
      .update({ status: entry.previousStatus })
      .eq("id", application.id);
    if (updateError) {
      results.push({
        applicationId: entry.applicationId,
        success: false,
        reason: updateError.message,
      });
      continue;
    }

    await recordAudit({
      entityType: "tutor_subject_preference",
      entityId: application.id,
      action: "restored",
      actorId: organiserId,
      before: { status: "approved" },
      after: {
        status: entry.previousStatus,
        via: "draft-restore",
        draftId: draft.id,
      },
    });

    results.push({ applicationId: entry.applicationId, success: true });
  }

  const { data: revertedDraft, error: revertError } = await supabase
    .from("allocation_drafts")
    .update({ status: "reverted" })
    .eq("id", draft.id)
    .select()
    .single();
  if (revertError) return res.status(500).json({ error: revertError.message });

  await recordAudit({
    entityType: "allocation_draft",
    entityId: draft.id,
    action: "restored",
    actorId: organiserId,
    before: { status: "published" },
    after: { status: "reverted" },
  });

  res.json({ draft: revertedDraft, results });
});

module.exports = router;
