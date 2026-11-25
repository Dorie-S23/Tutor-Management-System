const express = require("express");
const supabase = require("../supabaseClient");
const { getRatesMap } = require("./academicLevelRates");
const { notify } = require("./notificationHelpers");
const { hasTranscript, storageFailure } = require("./transcriptStorage");
const { recordAudit } = require("../utils/auditLog");

// Multi-objective balancing: the shared objective definitions, presets and
// scoring used to rank applicants — the same module the organiser board
// loads as a plain <script> for its preset picker and objective bars.
const AllocationObjectives = require("../../public/js/allocation-objectives");

const router = express.Router();

// academic_level -> numeric year, so it can be compared against a course's course_level
const LEVEL_RANK = {
  second_year: 2,
  third_year: 3,
  honours: 4,
  masters: 5,
  phd: 6,
};

const LEVEL_LABEL = {
  2: "2nd year",
  3: "3rd year",
  4: "Honours",
  5: "Masters",
  6: "PhD",
};

function toMinutes(timeStr) {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

// Every scheduled session (Tutorial and/or Lab) a course row carries.
function courseSessions(course) {
  const sessions = [];
  if (course.Day_of_tut && course.tutor_start_time && course.tutor_end_time) {
    sessions.push({
      type: "Tutorial",
      day: course.Day_of_tut,
      start: toMinutes(course.tutor_start_time),
      end: toMinutes(course.tutor_end_time),
    });
  }
  if (course.Day_of_lab && course.lab_start_time && course.lab_end_time) {
    sessions.push({
      type: "Lab",
      day: course.Day_of_lab,
      start: toMinutes(course.lab_start_time),
      end: toMinutes(course.lab_end_time),
    });
  }
  return sessions;
}

// ============================================================
// GET /api/tutor-applications
//
// ?tutorId=...          -> a tutor's own applications
// ?courseId=...         -> all applicants for a course, ranked
// ?preset=merit|balanced|fairness
//                       -> which balance of the competing ranking
//                          objectives to order applicants by
//                          (default: merit, the historical ranking)
// ============================================================
router.get("/", async (req, res) => {
  const { tutorId, courseId } = req.query;

  if (!tutorId && !courseId) {
    return res.status(400).json({
      error: "tutorId or courseId is required",
    });
  }

  // ------------------------------------------------------------
  // Which balance of the competing objectives should order these
  // applicants? Merit-first is the default and matches the historical
  // ranking exactly; the others re-weight it (see allocation-objectives.js).
  // Only the ranked courseId path uses a preset — a tutor's self-view
  // never orders anyone — and it's validated before the database is
  // touched, like every other input check in this repo.
  // ------------------------------------------------------------

  const preset =
    req.query.preset === undefined ? "merit" : String(req.query.preset);

  if (!tutorId && !AllocationObjectives.PRESET_NAMES.includes(preset)) {
    const valid = AllocationObjectives.PRESET_NAMES.join(", ");
    return res.status(400).json({
      error: `Unknown preset "${preset}". Valid presets: ${valid}.`,
    });
  }

  let query = supabase.from("tutor_subject_preference").select(
    `
      *,
      courses(
        course_code,
        course_name,
        course_level,
        hours_per_week,
        Day_of_tut,
        tutor_start_time,
        tutor_end_time,
        venues,
        Day_of_lab,
        lab_start_time,
        lab_end_time,
        lab_venues
      ),
      tutors(
        name,
        email,
        academic_level,
        weekly_hour_cap
      )
      `,
  );

  if (tutorId) {
    query = query.eq("tutor_id", tutorId);
  }

  if (courseId) {
    query = query.eq("course_id", courseId);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({
      error: error.message,
    });
  }

  // hourly_rate isn't a tutors column — it's derived from the tutor's
  // academic_level via the shared rate table, same as everywhere else
  // pay is calculated.
  const { ratesMap, error: ratesError } = await getRatesMap();
  if (ratesError) {
    return res.status(500).json({ error: ratesError.message });
  }
  (data || []).forEach((application) => {
    if (application.tutors) {
      application.tutors.hourly_rate =
        application.tutors.academic_level != null
          ? (ratesMap[application.tutors.academic_level] ?? null)
          : null;
    }
  });

  // ------------------------------------------------------------
  // If this is a tutor's own applications, don't need ranking.
  // ------------------------------------------------------------
  if (tutorId) {
    return res.json(data);
  }

  // ------------------------------------------------------------
  // Ranking applicants for an organiser
  // ------------------------------------------------------------

  const applicants = data || [];

  // Helper: convert HH:MM / HH:MM:SS into minutes
  function toMinutes(timeStr) {
    if (!timeStr) return null;

    const [hours, minutes] = timeStr.split(":").map(Number);

    return hours * 60 + minutes;
  }

  // Helper: determine whether two time periods overlap
  function overlaps(startA, endA, startB, endB) {
    return startA < endB && startB < endA;
  }

  // ------------------------------------------------------------
  // Calculate ranking information for every applicant
  // ------------------------------------------------------------

  const rankedApplicants = await Promise.all(
    applicants.map(async (application) => {
      const tutor = application.tutors;
      const course = application.courses;

      const tutorId = application.tutor_id;

      // --------------------------------------------------------
      // Academic level
      // --------------------------------------------------------

      const academicLevel = tutor?.academic_level;

      const academicRank = LEVEL_RANK[academicLevel] || 0;

      // --------------------------------------------------------
      // Mark
      // --------------------------------------------------------

      const mark = Number(application.tutor_mark) || 0;

      // --------------------------------------------------------
      // Availability
      // --------------------------------------------------------

      const available = application.Availability === true;

      // --------------------------------------------------------
      // Weekly workload + timetable clash detection
      // --------------------------------------------------------
      //
      // The workload check (hours from the tutor's other approved courses)
      // and the "clashes with courses already taught" check both read the
      // exact same rows — tutor_subject_preference for this tutor, approved,
      // excluding this course — just with different columns off the joined
      // course. One query serves both, fired alongside the busy-times query
      // instead of three sequential round trips.

      let currentAssignedHours = 0;
      let hoursRemaining = Infinity;
      let projectedHours = 0;
      let weeklyHourCap = tutor?.weekly_hour_cap ?? null;

      const courseDay = course?.Day_of_tut;
      const courseStart = toMinutes(course?.tutor_start_time);
      const courseEnd = toMinutes(course?.tutor_end_time);
      const courseIsScheduled =
        courseDay && courseStart != null && courseEnd != null;

      const [
        { data: otherApprovedCourses, error: otherApprovedError },
        busyTimesResult,
      ] = await Promise.all([
        supabase
          .from("tutor_subject_preference")
          .select(
            "courses(course_code, Day_of_tut, tutor_start_time, tutor_end_time, hours_per_week)",
          )
          .eq("tutor_id", tutorId)
          .eq("status", "approved")
          .neq("course_id", application.course_id),
        // Only worth fetching when the course actually has a schedule to clash against.
        courseIsScheduled
          ? supabase
              .from("tutor_busy_times")
              .select("title, day_of_week, start_time, end_time")
              .eq("tutor_id", tutorId)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (!otherApprovedError) {
        currentAssignedHours = (otherApprovedCourses || []).reduce(
          (sum, item) => {
            return sum + Number(item.courses?.hours_per_week || 0);
          },
          0,
        );
      }

      const courseHours = Number(course?.hours_per_week || 0);

      projectedHours = currentAssignedHours + courseHours;

      if (weeklyHourCap != null) {
        hoursRemaining = Math.max(
          Number(weeklyHourCap) - currentAssignedHours,
          0,
        );
      }

      let timetableClash = false;

      if (courseIsScheduled) {
        // Check the tutor's own busy times
        const { data: busyTimes, error: busyTimesError } = busyTimesResult;

        if (!busyTimesError && busyTimes) {
          for (const busy of busyTimes) {
            const busyStart = toMinutes(busy.start_time);
            const busyEnd = toMinutes(busy.end_time);

            if (
              busyStart != null &&
              busyEnd != null &&
              overlaps(courseStart, courseEnd, busyStart, busyEnd)
            ) {
              timetableClash = true;
              break;
            }
          }
        }

        // ------------------------------------------------------
        // Check clashes with courses the tutor already teaches
        // ------------------------------------------------------

        if (!timetableClash && !otherApprovedError) {
          for (const other of otherApprovedCourses || []) {
            const otherCourse = other.courses;

            if (!otherCourse || otherCourse.Day_of_tut !== courseDay) {
              continue;
            }

            const otherStart = toMinutes(otherCourse.tutor_start_time);

            const otherEnd = toMinutes(otherCourse.tutor_end_time);

            if (
              otherStart != null &&
              otherEnd != null &&
              overlaps(courseStart, courseEnd, otherStart, otherEnd)
            ) {
              timetableClash = true;
              break;
            }
          }
        }
      }

      // --------------------------------------------------------
      // The blended score itself is calculated after every applicant's
      // facts are known — see the balance() call below — because the
      // objectives compete with each other and need the full pool to
      // rank, flag Pareto-dominated applicants and explain trade-offs.
      // --------------------------------------------------------

      // --------------------------------------------------------
      // Override info — was this approval pushed through past a
      // blocking rule? Only relevant once approved.
      // --------------------------------------------------------

      let overrideInfo = null;

      if (application.status === "approved") {
        const { data: overrides } = await supabase
          .from("allocation_overrides")
          .select("rule_overridden, reason, created_at")
          .eq("tutor_id", tutorId)
          .eq("course_id", application.course_id)
          .order("created_at", { ascending: false })
          .limit(1);

        if (overrides && overrides.length > 0) {
          overrideInfo = overrides[0];
        }
      }

      return {
        ...application,

        overrideInfo,

        ranking: {
          mark,
          available,
          timetableClash,
          academicLevel,
          academicRank,
          weeklyHourCap,
          currentAssignedHours,
          hoursRemaining:
            hoursRemaining === Infinity ? null : Number(hoursRemaining),
          projectedHours,
        },
      };
    }),
  );

  // ------------------------------------------------------------
  // Blend the competing objectives (mark, availability, timetable
  // fit, seniority, spare hours) into a single 0-100 score under
  // the chosen preset, and order the applicants by it. The merit
  // preset's weights are the historical point scale, so the default
  // ordering is unchanged; the others re-weight the same facts.
  // ------------------------------------------------------------

  const balanced = AllocationObjectives.balance(
    rankedApplicants.map((app) => app.ranking),
    preset,
  );

  balanced.forEach((result) => {
    const app = rankedApplicants[result.index];
    app.ranking.preset = preset;
    app.ranking.score = result.score;
    app.ranking.objectives = result.objectives;
    app.ranking.rank = result.rank;
    app.ranking.meritRank = result.meritRank;
    app.ranking.paretoDominated = result.dominated;
    app.ranking.tradeoff = result.note;
  });

  res.json(balanced.map((result) => rankedApplicants[result.index]));
});

// ============================================================
// POST /api/tutor-applications
// Apply to tutor a course
// ============================================================

router.post("/", async (req, res) => {
  const { tutorId, courseId, mark, availability, academicLevel } =
    req.body ?? {};

  if (!tutorId || !courseId) {
    return res.status(400).json({
      error: "tutorId and courseId are required",
    });
  }

  const markNum = Number(mark);

  if (!Number.isInteger(markNum) || markNum < 0 || markNum > 100) {
    return res.status(400).json({
      error: "mark must be an integer between 0 and 100",
    });
  }

  if (typeof availability !== "boolean") {
    return res.status(400).json({
      error: "availability is required",
    });
  }

  // Self-reported by the tutor — not set by an organiser
  if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, academicLevel)) {
    return res.status(400).json({
      error: "Please select your year of study",
    });
  }

  const { data: tutor, error: tutorError } = await supabase
    .from("tutors")
    .select("name")
    .eq("id", tutorId)
    .single();

  if (tutorError || !tutor) {
    return res.status(404).json({
      error: "Tutor not found",
    });
  }

  const { data: course, error: courseError } = await supabase
    .from("courses")
    .select(
      "course_code, course_name, course_level, Day_of_tut, tutor_start_time, tutor_end_time, Day_of_lab, lab_start_time, lab_end_time",
    )
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({
      error: "Course not found",
    });
  }

  // A tutor must be at this course's minimum level or higher.
  if (course.course_level == null) {
    return res.status(403).json({
      error: `${course.course_code} doesn't have a year level set yet — ask an organiser to set it before applying.`,
    });
  }

  const tutorYear = LEVEL_RANK[academicLevel];

  if (tutorYear < course.course_level) {
    const requiredLabel =
      LEVEL_LABEL[course.course_level] || `level ${course.course_level}`;
    return res.status(403).json({
      error: `You need to be at ${requiredLabel} level or higher to tutor ${course.course_code}.`,
    });
  }

  // Persist tutor's self-reported year of study
  const { error: levelUpdateError } = await supabase
    .from("tutors")
    .update({
      academic_level: academicLevel,
    })
    .eq("id", tutorId);

  if (levelUpdateError) {
    return res.status(500).json({
      error: levelUpdateError.message,
    });
  }

  const { data: existing, error: existingError } = await supabase
    .from("tutor_subject_preference")
    .select("id")
    .eq("tutor_id", tutorId)
    .eq("course_id", courseId)
    .maybeSingle();

  if (existingError) {
    return res.status(500).json({
      error: existingError.message,
    });
  }

  if (existing) {
    return res.status(409).json({
      error: `You've already applied to tutor ${course.course_code}.`,
    });
  }

  // An application needs a transcript on file for the organiser to review —
  // the upload section below this page's course boards provides it.
  const transcript = await hasTranscript(tutorId);
  if (transcript.error) {
    return storageFailure(res, transcript.error);
  }
  if (!transcript.has) {
    return res.status(403).json({
      error: "Please upload your transcript before applying.",
    });
  }

  // A tutor can't be double-booked across two modules they tutor — check
  // this course's Tutorial/Lab against every module they're already
  // approved to tutor, regardless of venue (they can't be in two places at
  // once even if the rooms differ — that's a separate, venue-only check
  // done when the course itself is scheduled).
  const newSessions = courseSessions(course);

  if (newSessions.length > 0) {
    const { data: approvedApplications, error: approvedError } = await supabase
      .from("tutor_subject_preference")
      .select(
        "courses(course_code, Day_of_tut, tutor_start_time, tutor_end_time, Day_of_lab, lab_start_time, lab_end_time)",
      )
      .eq("tutor_id", tutorId)
      .eq("status", "approved");

    if (approvedError) {
      return res.status(500).json({ error: approvedError.message });
    }

    for (const approved of approvedApplications || []) {
      const otherCourse = approved.courses;
      if (!otherCourse) continue;

      for (const mine of newSessions) {
        for (const other of courseSessions(otherCourse)) {
          if (
            mine.day === other.day &&
            overlaps(mine.start, mine.end, other.start, other.end)
          ) {
            return res.status(409).json({
              error: `Your ${mine.type} for ${course.course_code} clashes with your ${other.type} for ${otherCourse.course_code} (${mine.day}) — you're already approved to tutor that module at an overlapping time.`,
            });
          }
        }
      }
    }
  }

  const { data, error } = await supabase
    .from("tutor_subject_preference")
    .insert({
      tutor_id: tutorId,
      course_id: courseId,
      status: "pending",
      Tutor_name: tutor.name,
      tutor_mark: markNum,
      Availability: availability,
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({
      error: error.message,
    });
  }

  res.status(201).json(data);
});

// GET /api/tutor-applications/obvious-fill — pending applications that can be
// approved with no judgment call: the tutor's mark clears the course's bar,
// they're free at the tutorial time, and there aren't more such applicants
// than the course has open slots (so nobody has to be picked over anybody
// else). Courses with no eligible applicant, or more eligible applicants
// than slots, are left out — those need an organiser's judgment.
router.get("/obvious-fill", async (req, res) => {
  const { data: courses, error: coursesError } = await supabase
    .from("courses")
    .select(
      "id, course_code, course_name, min_mark, tutors_needed, no_of_tutors_assigned",
    );

  if (coursesError)
    return res.status(500).json({ error: coursesError.message });

  const { data: applications, error: applicationsError } = await supabase
    .from("tutor_subject_preference")
    .select("id, course_id, tutor_mark, Availability, Tutor_name")
    .eq("status", "pending");

  if (applicationsError)
    return res.status(500).json({ error: applicationsError.message });

  const groups = [];

  for (const course of courses) {
    const remainingSlots =
      (course.tutors_needed ?? 0) - (course.no_of_tutors_assigned ?? 0);
    if (remainingSlots <= 0) continue;

    const eligible = applications.filter(
      (app) =>
        app.course_id === course.id &&
        typeof app.tutor_mark === "number" &&
        app.tutor_mark >= course.min_mark &&
        app.Availability === true,
    );

    if (eligible.length === 0 || eligible.length > remainingSlots) continue;

    groups.push({
      course: {
        id: course.id,
        code: course.course_code,
        name: course.course_name,
      },
      applications: eligible.map((app) => ({
        id: app.id,
        tutorName: app.Tutor_name,
        mark: app.tutor_mark,
      })),
    });
  }

  res.json(groups);
});

// Optimistic-concurrency wording for the write routes below. A write whose
// client-declared (or just-read) state no longer matches the row when the
// write lands is refused with a 409 instead of silently overwriting
// whatever another organiser did first.
const STALE_APPLICATION_ERROR =
  "Someone else already changed this application — reload to see the latest state.";
const STALE_APPLICATION_SHORT = "Someone else already changed this application";
const STALE_COURSE_ERROR =
  "Someone else just changed this course's assignments — reload to see the latest state.";

// Best-effort undo for a course counter bump whose paired status write then
// lost its race: only writes while the counter still holds the value this
// request set, so it can never clobber a newer change by someone else.
async function rollbackCourseCount(courseId, restoreTo, onlyIfStill) {
  const { error } = await supabase
    .from("courses")
    .update({ no_of_tutors_assigned: restoreTo })
    .eq("id", courseId)
    .eq("no_of_tutors_assigned", onlyIfStill)
    .select()
    .single();

  if (error) {
    console.warn(
      "Failed to roll back no_of_tutors_assigned after a lost race:",
      error.message,
    );
  }
}

// POST /api/tutor-applications/bulk-approve — approve several applications in
// one action. Runs the same eligibility/capacity checks a single PATCH would,
// one row at a time (not in parallel) so two applications for the same course
// can't both slip past its capacity in a race.
router.post("/bulk-approve", async (req, res) => {
  const { applicationIds } = req.body ?? {};
  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    return res
      .status(400)
      .json({ error: "applicationIds must be a non-empty array" });
  }

  const results = [];

  for (const id of applicationIds) {
    const { data: application, error: applicationError } = await supabase
      .from("tutor_subject_preference")
      .select("id, status, course_id, tutor_id, Tutor_name")
      .eq("id", id)
      .single();

    if (applicationError || !application) {
      results.push({ id, success: false, error: "Application not found" });
      continue;
    }

    if (application.status === "approved") {
      results.push({ id, success: true, name: application.Tutor_name });
      continue;
    }

    // The list these came from only shows pending applications, so a row
    // that is anything else (e.g. rejected in another tab meanwhile) is a
    // changed-under-you conflict, not something to quietly re-approve.
    if (application.status !== "pending") {
      results.push({
        id,
        success: false,
        error: STALE_APPLICATION_SHORT,
      });
      continue;
    }

    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned, tutors_needed, course_code, course_name")
      .eq("id", application.course_id)
      .single();

    if (courseError || !course) {
      results.push({ id, success: false, error: "Course not found" });
      continue;
    }

    const next = (course.no_of_tutors_assigned ?? 0) + 1;
    if (next > course.tutors_needed) {
      results.push({
        id,
        success: false,
        error: "This course already has all the tutors it needs",
      });
      continue;
    }

    // Guarded counter bump: the WHERE only matches while the course's count
    // still holds the value this iteration read, so a concurrent approval
    // for the same course fails this item instead of being overwritten.
    let bumpQuery = supabase
      .from("courses")
      .update({ no_of_tutors_assigned: next })
      .eq("id", application.course_id);

    if (course.no_of_tutors_assigned != null) {
      bumpQuery = bumpQuery.eq(
        "no_of_tutors_assigned",
        course.no_of_tutors_assigned,
      );
    }

    const { error: bumpError } = await bumpQuery.select().single();

    if (bumpError) {
      results.push({
        id,
        success: false,
        error:
          bumpError.code === "PGRST116"
            ? STALE_APPLICATION_SHORT
            : bumpError.message,
      });
      continue;
    }

    const { error: updateError } = await supabase
      .from("tutor_subject_preference")
      .update({ status: "approved" })
      .eq("id", id)
      // Atomic backstop, mirroring the single-application PATCH: the write
      // only lands if the status is still the one this iteration read.
      .eq("status", application.status)
      .select()
      .single();

    if (updateError) {
      if (updateError.code === "PGRST116") {
        // Put the counter back — the approval this bump was for never
        // actually landed.
        await rollbackCourseCount(
          application.course_id,
          Math.max(course.no_of_tutors_assigned ?? 0, 0),
          next,
        );
        results.push({
          id,
          success: false,
          error: STALE_APPLICATION_SHORT,
        });
        continue;
      }
      results.push({ id, success: false, error: updateError.message });
      continue;
    }

    notify(application.tutor_id, {
      type: "application_status",
      message: `You've been approved to tutor ${course.course_code}${course.course_name ? ` — ${course.course_name}` : ""}.`,
      relatedEntity: "application",
      relatedId: application.id,
    }).catch((err) =>
      console.warn("Failed to notify about application status:", err),
    );

    await recordAudit({
      entityType: "tutor_subject_preference",
      entityId: id,
      action: "approved",
      actorId: req.body?.organiserId ?? null,
      before: { status: application.status },
      after: { status: "approved", via: "bulk-approve" },
    });

    results.push({ id, success: true, name: application.Tutor_name });
  }

  res.json({ results });
});

// ============================================================
// PATCH /api/tutor-applications/:id
//
// Organiser approves/rejects/resets an application.
// ============================================================

const VALID_STATUSES = ["pending", "approved", "rejected"];

router.patch("/:id", async (req, res) => {
  const {
    status,
    override,
    organiserId,
    reason,
    rejectionReason,
    approvalReason,
    expectedStatus,
  } = req.body ?? {};

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "status must be pending, approved or rejected",
    });
  }

  if (status === "rejected" && (!rejectionReason || !rejectionReason.trim())) {
    return res.status(400).json({
      error: "A reason is required to reject an application",
    });
  }

  if (status === "approved" && (!approvalReason || !approvalReason.trim())) {
    return res.status(400).json({
      error: "A reason is required to approve an application",
    });
  }

  const overrideRequested = override === true;

  if (overrideRequested) {
    if (!organiserId) {
      return res.status(400).json({
        error: "organiserId is required to record an override",
      });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error: "A reason is required to record an override",
      });
    }
  }

  // The caller declares the status it acted on. Validated last of the input
  // checks so bad-input errors above keep their more specific messages.
  if (!VALID_STATUSES.includes(expectedStatus)) {
    return res.status(400).json({
      error:
        "expectedStatus is required and must be pending, approved or rejected",
    });
  }

  const bypassedRules = [];

  const { data: application, error: applicationError } = await supabase
    .from("tutor_subject_preference")
    .select("id, status, course_id, tutor_id, locked")
    .eq("id", req.params.id)
    .single();

  if (applicationError || !application) {
    return res.status(404).json({
      error: "Application not found",
    });
  }

  if (application.locked) {
    return res.status(409).json({
      error: "This application is locked and can't be reconsidered.",
    });
  }

  // Optimistic-concurrency check: the request declares the status it acted
  // on, and a mismatch means another organiser already moved it — refuse
  // rather than overwrite their change.
  if (application.status !== expectedStatus) {
    return res.status(409).json({
      error: STALE_APPLICATION_ERROR,
    });
  }

  const wasApproved = application.status === "approved";

  const willBeApproved = status === "approved";

  // Filled in once the course counter has been written, so a status write
  // that loses its race moments later can put it back.
  let bumpRollback = null;

  if (wasApproved !== willBeApproved) {
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned, tutors_needed, hours_per_week")
      .eq("id", application.course_id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({
        error: "Course not found",
      });
    }

    const next =
      (course.no_of_tutors_assigned ?? 0) + (willBeApproved ? 1 : -1);

    if (willBeApproved && next > course.tutors_needed) {
      if (!overrideRequested) {
        return res.status(409).json({
          error: "This course already has all the tutors it needs",
        });
      }
      bypassedRules.push({
        rule_overridden: "course_capacity",
        detail: `Would be ${next}/${course.tutors_needed} tutors assigned`,
      });
    }

    // Weekly hour cap check
    if (willBeApproved) {
      const { data: tutor, error: tutorError } = await supabase
        .from("tutors")
        .select("weekly_hour_cap")
        .eq("id", application.tutor_id)
        .single();

      if (tutorError || !tutor) {
        return res.status(404).json({
          error: "Tutor not found",
        });
      }

      if (tutor.weekly_hour_cap != null) {
        const { data: otherApprovals, error: otherApprovalsError } =
          await supabase
            .from("tutor_subject_preference")
            .select("courses(hours_per_week)")
            .eq("tutor_id", application.tutor_id)
            .eq("status", "approved")
            .neq("course_id", application.course_id);

        if (otherApprovalsError) {
          return res.status(500).json({
            error: otherApprovalsError.message,
          });
        }

        const currentAssignedHours = (otherApprovals || []).reduce(
          (sum, a) => sum + (a.courses?.hours_per_week || 0),
          0,
        );

        const projectedHours =
          currentAssignedHours + (course.hours_per_week || 0);

        if (projectedHours > tutor.weekly_hour_cap) {
          if (!overrideRequested) {
            return res.status(409).json({
              error: `This would put the tutor at ${projectedHours} hrs/week, over their ${tutor.weekly_hour_cap} hr cap`,
            });
          }
          bypassedRules.push({
            rule_overridden: "weekly_hour_cap",
            detail: `Would put tutor at ${projectedHours}/${tutor.weekly_hour_cap} hrs/week`,
          });
        }
      }
    }

    const guardedCount = Math.max(next, 0);

    // Optimistic-concurrency guard on the counter: the WHERE only matches
    // while the count is still the one this request read, so a course
    // another organiser just changed fails the bump instead of being
    // clobbered. (A null column can't be compared with eq, so it's
    // skipped — a null count is treated like a fresh 0.)
    let bumpQuery = supabase
      .from("courses")
      .update({
        no_of_tutors_assigned: guardedCount,
      })
      .eq("id", application.course_id);

    if (course.no_of_tutors_assigned != null) {
      bumpQuery = bumpQuery.eq(
        "no_of_tutors_assigned",
        course.no_of_tutors_assigned,
      );
    }

    const { error: bumpError } = await bumpQuery.select().single();

    if (bumpError) {
      if (bumpError.code === "PGRST116") {
        return res.status(409).json({
          error: STALE_COURSE_ERROR,
        });
      }
      return res.status(500).json({
        error: bumpError.message,
      });
    }

    bumpRollback = {
      restoreTo: Math.max(course.no_of_tutors_assigned ?? 0, 0),
      onlyIfStill: guardedCount,
    };
  }

  const { data, error } = await supabase
    .from("tutor_subject_preference")
    .update({
      status,
      rejection_reason: status === "rejected" ? rejectionReason.trim() : null,
      approval_reason: status === "approved" ? approvalReason.trim() : null,
    })
    .eq("id", req.params.id)
    // Atomic backstop for the check above: the write itself only lands if
    // the row still holds the status this request read (PGRST116 → 409).
    .eq("status", expectedStatus)
    .select(
      `
        *,
        courses(
          course_code,
          course_name
        ),
        tutors(
          name,
          email,
          academic_level
        )
        `,
    )
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // Someone changed the row between the read and this write. Undo the
      // counter bump if there was one, so the course doesn't drift.
      if (bumpRollback) {
        await rollbackCourseCount(
          application.course_id,
          bumpRollback.restoreTo,
          bumpRollback.onlyIfStill,
        );
      }
      return res.status(409).json({
        error: STALE_APPLICATION_ERROR,
      });
    }
    return res.status(500).json({
      error: error.message,
    });
  }

  if (bypassedRules.length > 0) {
    const { error: overrideError } = await supabase
      .from("allocation_overrides")
      .insert(
        bypassedRules.map((r) => ({
          organiser_id: organiserId,
          tutor_id: application.tutor_id,
          course_id: application.course_id,
          rule_overridden: r.rule_overridden,
          reason: `${reason.trim()} (${r.detail})`,
        })),
      );

    if (overrideError) {
      return res.status(500).json({
        error: `The approval went through, but the override reason couldn't be saved: ${overrideError.message}`,
      });
    }
  }

  if (status === "approved" || status === "rejected") {
    const courseLabel = data.courses?.course_code || "a course";
    const message =
      status === "approved"
        ? `You've been approved to tutor ${courseLabel}${data.courses?.course_name ? ` — ${data.courses.course_name}` : ""}.`
        : wasApproved
          ? `You've been removed from ${courseLabel} — you were previously approved to tutor it: ${rejectionReason.trim()}`
          : `Your application to tutor ${courseLabel} was rejected: ${rejectionReason.trim()}`;

    notify(application.tutor_id, {
      type: "application_status",
      message,
      relatedEntity: "application",
      relatedId: application.id,
    }).catch((err) =>
      console.warn("Failed to notify about application status:", err),
    );
  }

  // Awaited (not fire-and-forget) so the write actually happens before the
  // response ends — this runs on Cloudflare Workers in production, where
  // execution can be torn down right after the response is sent.
  await recordAudit({
    entityType: "tutor_subject_preference",
    entityId: application.id,
    action: status,
    actorId: organiserId ?? null,
    before: { status: application.status },
    after: {
      status,
      overridden: bypassedRules.map((r) => r.rule_overridden),
    },
  });

  res.json(data);
});

// PATCH /api/tutor-applications/:id/lock — permanently lock an approved
// assignment or a rejected application. This is intentionally one-way:
// there is no unlock. Once locked, PATCH /:id refuses any status change to
// this record, and DELETE /:id refuses to withdraw it — a locked rejection
// therefore can't be cleared, so the tutor can never re-apply for the
// course.
router.patch("/:id/lock", async (req, res) => {
  const { locked } = req.body ?? {};
  if (locked !== true) {
    return res.status(400).json({
      error: "locked must be true — locking is permanent and cannot be undone",
    });
  }

  const { data: application, error: applicationError } = await supabase
    .from("tutor_subject_preference")
    .select("id, status, locked")
    .eq("id", req.params.id)
    .single();

  if (applicationError || !application) {
    return res.status(404).json({ error: "Application not found" });
  }

  if (application.locked) {
    return res.status(409).json({
      error: "This application is already locked and cannot be changed",
    });
  }

  // A pending application still has an organiser's decision ahead of it —
  // locking is for recording a decision as final, not for freezing the
  // queue.
  if (application.status !== "approved" && application.status !== "rejected") {
    return res.status(409).json({
      error: "Only an approved or rejected application can be locked",
    });
  }

  const { data, error } = await supabase
    .from("tutor_subject_preference")
    .update({ locked: true })
    .eq("id", req.params.id)
    // Atomic guards mirroring the checks above: only an approved or
    // rejected, still-unlocked row is locked — 0 matches is a 409, not a
    // silent no-op.
    .eq("locked", false)
    .in("status", ["approved", "rejected"])
    .select(
      `
        *,
        courses(
          course_code,
          course_name
        ),
        tutors(
          name,
          email,
          academic_level
        )
        `,
    )
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return res.status(409).json({
        error:
          "This assignment was just changed by someone else — reload to see the latest state.",
      });
    }
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

// DELETE /api/tutor-applications/:id — a tutor withdraws their own application.
// Keeps the course's no_of_tutors_assigned counter in sync if it was approved.
// A locked record can't be withdrawn at all — an organiser's lock (approval
// or rejection) is final, and for a rejection that's exactly what stops the
// tutor clearing it to re-apply.
router.delete("/:id", async (req, res) => {
  const { data: application, error: applicationError } = await supabase
    .from("tutor_subject_preference")
    .select("id, status, course_id, locked")
    .eq("id", req.params.id)
    .single();

  if (applicationError || !application) {
    return res.status(404).json({ error: "Application not found" });
  }

  if (application.locked) {
    return res.status(409).json({
      error: "This application is locked and can't be withdrawn.",
    });
  }

  if (application.status === "approved") {
    const { data: course, error: courseError } = await supabase
      .from("courses")
      .select("no_of_tutors_assigned")
      .eq("id", application.course_id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({ error: "Course not found" });
    }

    const { error: bumpError } = await supabase
      .from("courses")
      .update({
        no_of_tutors_assigned: Math.max(
          (course.no_of_tutors_assigned ?? 0) - 1,
          0,
        ),
      })
      .eq("id", application.course_id);

    if (bumpError) return res.status(500).json({ error: bumpError.message });
  }

  const { error } = await supabase
    .from("tutor_subject_preference")
    .delete()
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  await recordAudit({
    entityType: "tutor_subject_preference",
    entityId: application.id,
    action: "withdrawn",
    actorId: application.tutor_id,
    before: { status: application.status },
    after: null,
  });

  res.status(204).end();
});

module.exports = router;
