const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// academic_level -> numeric year, so it can be compared against a course's course_level
const LEVEL_RANK = {
  second_year: 2,
  third_year: 3,
  honours: 4,
  masters: 5,
  phd: 6,
};

// ============================================================
// GET /api/tutor-applications
//
// ?tutorId=...  -> a tutor's own applications
// ?courseId=... -> all applicants for a course, ranked
// ============================================================
router.get("/", async (req, res) => {
  const { tutorId, courseId } = req.query;

  if (!tutorId && !courseId) {
    return res.status(400).json({
      error: "tutorId or courseId is required",
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
        tutor_end_time
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
      // Weekly workload
      // --------------------------------------------------------

      let currentAssignedHours = 0;
      let hoursRemaining = Infinity;
      let projectedHours = 0;
      let weeklyHourCap = tutor?.weekly_hour_cap ?? null;

      const { data: approvedApplications, error: approvedError } =
        await supabase
          .from("tutor_subject_preference")
          .select("courses(hours_per_week)")
          .eq("tutor_id", tutorId)
          .eq("status", "approved")
          .neq("course_id", application.course_id);

      if (!approvedError) {
        currentAssignedHours = (approvedApplications || []).reduce(
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

      // --------------------------------------------------------
      // Timetable clash detection
      // --------------------------------------------------------

      let timetableClash = false;

      const courseDay = course?.Day_of_tut;

      const courseStart = toMinutes(course?.tutor_start_time);
      const courseEnd = toMinutes(course?.tutor_end_time);

      // Only perform clash checking when the course has a schedule.
      if (courseDay && courseStart != null && courseEnd != null) {
        // Check the tutor's own busy times
        const { data: busyTimes, error: busyTimesError } = await supabase
          .from("tutor_busy_times")
          .select("title, day_of_week, start_time, end_time")
          .eq("tutor_id", tutorId);

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

        if (!timetableClash) {
          const { data: otherCourses, error: otherCoursesError } =
            await supabase
              .from("tutor_subject_preference")
              .select(
                `
                courses(
                  course_code,
                  Day_of_tut,
                  tutor_start_time,
                  tutor_end_time
                )
                `,
              )
              .eq("tutor_id", tutorId)
              .eq("status", "approved")
              .neq("course_id", application.course_id);

          if (!otherCoursesError && otherCourses) {
            for (const other of otherCourses) {
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
      }

      // --------------------------------------------------------
      // Calculate a ranking score
      // --------------------------------------------------------
      //
      // The score is intentionally weighted so that academic
      // performance is the strongest factor.
      //
      // Mark:             0 - 100 points
      // Availability:     0 - 20 points
      // No timetable clash: 0 - 20 points
      // Academic level:   0 - 10 points
      // Hours remaining:  0 - 10 points
      //
      // Maximum = 160
      // --------------------------------------------------------

      let score = 0;

      // 1. Mark
      score += mark;

      // 2. Availability
      if (available) {
        score += 20;
      }

      // 3. Timetable clash
      if (!timetableClash) {
        score += 20;
      }

      // 4. Academic level
      score += academicRank * 2;

      // 5. Hours remaining
      //
      // If there is no cap, give the maximum workload points.
      if (weeklyHourCap == null) {
        score += 10;
      } else if (weeklyHourCap > 0) {
        const workloadRatio = hoursRemaining / Number(weeklyHourCap);

        score += Math.min(Math.max(workloadRatio, 0), 1) * 10;
      }

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
          score: Number(score.toFixed(2)),
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
  // Sort applicants from highest score to lowest score
  // ------------------------------------------------------------

  rankedApplicants.sort((a, b) => {
    // Primary: ranking score
    if (b.ranking.score !== a.ranking.score) {
      return b.ranking.score - a.ranking.score;
    }

    // Tie-breaker 1: higher mark
    if (b.ranking.mark !== a.ranking.mark) {
      return b.ranking.mark - a.ranking.mark;
    }

    // Tie-breaker 2: available applicant first
    if (a.ranking.available !== b.ranking.available) {
      return a.ranking.available ? -1 : 1;
    }

    // Tie-breaker 3: no timetable clash first
    if (a.ranking.timetableClash !== b.ranking.timetableClash) {
      return a.ranking.timetableClash ? 1 : -1;
    }

    // Tie-breaker 4: higher academic level
    if (b.ranking.academicRank !== a.ranking.academicRank) {
      return b.ranking.academicRank - a.ranking.academicRank;
    }

    return 0;
  });

  res.json(rankedApplicants);
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
    .select("course_code, course_name, course_level")
    .eq("id", courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({
      error: "Course not found",
    });
  }

  // A tutor must be at least one year ahead of the course.
  if (course.course_level == null) {
    return res.status(403).json({
      error: `${course.course_code} doesn't have a year level set yet — ask an organiser to set it before applying.`,
    });
  }

  const tutorYear = LEVEL_RANK[academicLevel];

  if (tutorYear <= course.course_level) {
    return res.status(403).json({
      error: `You need to be at least one year ahead of ${course.course_code} (level ${course.course_level}) to tutor it.`,
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

// ============================================================
// PATCH /api/tutor-applications/:id
//
// Organiser approves/rejects/resets an application.
// ============================================================

const VALID_STATUSES = ["pending", "approved", "rejected"];

router.patch("/:id", async (req, res) => {
  const { status, override, organiserId, reason } = req.body ?? {};

  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "status must be pending, approved or rejected",
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

  const bypassedRules = [];

  const { data: application, error: applicationError } = await supabase
    .from("tutor_subject_preference")
    .select("id, status, course_id, tutor_id")
    .eq("id", req.params.id)
    .single();

  if (applicationError || !application) {
    return res.status(404).json({
      error: "Application not found",
    });
  }

  const wasApproved = application.status === "approved";

  const willBeApproved = status === "approved";

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

    const { error: bumpError } = await supabase
      .from("courses")
      .update({
        no_of_tutors_assigned: Math.max(next, 0),
      })
      .eq("id", application.course_id);

    if (bumpError) {
      return res.status(500).json({
        error: bumpError.message,
      });
    }
  }

  const { data, error } = await supabase
    .from("tutor_subject_preference")
    .update({ status })
    .eq("id", req.params.id)
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

  res.json(data);
});

module.exports = router;
