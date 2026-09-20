const express = require("express");
const supabase = require("../supabaseClient");
const { recordAudit } = require("../utils/auditLog");

const router = express.Router();

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
// every course with open slots, in one pass across the whole school. For
// each course: pending applicants meeting the mark bar and marked available
// are eligible; if there are more eligible applicants than slots, they're
// ranked by mark (highest first, tie-broken by application id for a
// deterministic order) and only the top N are proposed. Nothing is applied
// yet — this just writes a draft for an organiser to review and publish.
router.post("/auto-allocate", async (req, res) => {
  const { organiserId, name } = req.body ?? {};
  if (!organiserId) {
    return res.status(400).json({ error: "organiserId is required" });
  }

  const { data: courses, error: coursesError } = await supabase
    .from("courses")
    .select(
      "id, course_code, course_name, min_mark, tutors_needed, no_of_tutors_assigned",
    );
  if (coursesError)
    return res.status(500).json({ error: coursesError.message });

  const { data: applications, error: applicationsError } = await supabase
    .from("tutor_subject_preference")
    .select("id, tutor_id, course_id, tutor_mark, Availability, Tutor_name")
    .eq("status", "pending");
  if (applicationsError)
    return res.status(500).json({ error: applicationsError.message });

  const proposals = [];

  for (const course of courses) {
    const remainingSlots =
      (course.tutors_needed ?? 0) - (course.no_of_tutors_assigned ?? 0);
    if (remainingSlots <= 0) continue;

    const eligible = applications
      .filter(
        (app) =>
          app.course_id === course.id &&
          typeof app.tutor_mark === "number" &&
          app.tutor_mark >= course.min_mark &&
          app.Availability === true,
      )
      .sort((a, b) => b.tutor_mark - a.tutor_mark || (a.id > b.id ? 1 : -1));

    if (eligible.length === 0) continue;

    const picked = eligible.slice(0, remainingSlots);

    picked.forEach((app, index) => {
      const explanation =
        eligible.length <= remainingSlots
          ? `Only eligible applicant for this slot (mark ${app.tutor_mark}, course minimum ${course.min_mark})`
          : `Ranked #${index + 1} of ${eligible.length} eligible applicants by mark (${app.tutor_mark})`;

      proposals.push({
        tutor_id: app.tutor_id,
        course_id: course.id,
        explanation,
        locked: false,
      });
    });
  }

  if (proposals.length === 0) {
    return res.status(200).json({
      draft: null,
      assignments: [],
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
      .select("no_of_tutors_assigned, tutors_needed")
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
