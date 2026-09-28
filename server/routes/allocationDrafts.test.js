const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const allocationDraftsRouter = require("./allocationDrafts");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/allocation-drafts", allocationDraftsRouter);
  return app;
}

beforeEach(() => {
  tables = {
    courses: [],
    tutors: [],
    tutor_subject_preference: [],
    tutor_busy_times: [],
    allocation_drafts: [],
    allocation_draft_assignments: [],
    audit_log: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("POST /api/allocation-drafts/auto-allocate", () => {
  test("requires organiserId", async () => {
    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({});

    expect(res.status).toBe(400);
  });

  test("returns no draft when nothing qualifies", async () => {
    tables.courses = [
      { id: 1, min_mark: 60, tutors_needed: 1, no_of_tutors_assigned: 1 },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeNull();
    expect(res.body.assignments).toEqual([]);
    expect(tables.allocation_drafts).toHaveLength(0);
  });

  test("proposes the sole eligible applicant as an obvious pick", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutors = [{ id: "t1", name: "Alice", email: "alice@example.com" }];
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        tutor_id: "t1",
        course_id: 1,
        status: "pending",
        tutor_mark: 75,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    expect(res.body.draft).toMatchObject({
      status: "draft",
      created_by: "organiser-1",
    });
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0]).toMatchObject({
      tutor_id: "t1",
      course_id: 1,
    });
    expect(res.body.assignments[0].explanation).toContain(
      "Only eligible applicant",
    );
    expect(res.body.assignments[0].tutor.name).toBe("Alice");
    expect(res.body.assignments[0].course.course_code).toBe("COMS1000");
  });

  test("ranks ambiguous cases by mark and only proposes the top N for the open slots", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-lo",
        tutor_id: "t-lo",
        course_id: 1,
        status: "pending",
        tutor_mark: 65,
        Availability: true,
      },
      {
        id: "app-hi",
        tutor_id: "t-hi",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
      },
      {
        id: "app-mid",
        tutor_id: "t-mid",
        course_id: 1,
        status: "pending",
        tutor_mark: 80,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].tutor_id).toBe("t-hi");
    expect(res.body.assignments[0].explanation).toContain("Ranked #1 of 3");
  });

  test("excludes applicants below the mark bar or marked unavailable", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "C1",
        min_mark: 60,
        tutors_needed: 2,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-lowmark",
        tutor_id: "t1",
        course_id: 1,
        status: "pending",
        tutor_mark: 40,
        Availability: true,
      },
      {
        id: "app-unavail",
        tutor_id: "t2",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: false,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeNull();
  });

  test("skips a locked application and reports why, without proposing it", async () => {
    tables.courses = [
      { id: 1, min_mark: 60, tutors_needed: 1, no_of_tutors_assigned: 0 },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-locked",
        tutor_id: "t1",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
        locked: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeNull();
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        tutorId: "t1",
        courseId: 1,
        reason: expect.stringContaining("locked"),
      }),
    ]);
  });

  test("excludes an applicant who would exceed their weekly hour cap, and reports why", async () => {
    tables.courses = [
      {
        id: 1,
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
        hours_per_week: 5,
      },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: 10 }];
    // Already at 8 approved hours elsewhere; +5 for this course would be 13, over the 10 cap.
    tables.tutor_subject_preference = [
      {
        id: "app-other",
        tutor_id: "t1",
        course_id: 2,
        status: "approved",
        courses: { hours_per_week: 8 },
      },
      {
        id: "app-1",
        tutor_id: "t1",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft).toBeNull();
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        tutorId: "t1",
        courseId: 1,
        reason: expect.stringContaining("10 hr/week cap"),
      }),
    ]);
  });

  test("checks the hour cap cumulatively across two courses proposed in the same run", async () => {
    tables.courses = [
      {
        id: 1,
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
        hours_per_week: 6,
      },
      {
        id: 2,
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
        hours_per_week: 6,
      },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: 10 }];
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        tutor_id: "t1",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
      },
      {
        id: "app-2",
        tutor_id: "t1",
        course_id: 2,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    // The first course's 6 hours fit under the cap alone, but the second
    // course's additional 6 would push the same tutor to 12/10 — so only
    // one of the two gets proposed, and the other shows up as skipped.
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        tutorId: "t1",
        reason: expect.stringContaining("10 hr/week cap"),
      }),
    ]);
  });

  test("prefers a non-clashing candidate only when marks are tied", async () => {
    tables.courses = [
      {
        id: 1,
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
        Day_of_tut: "Monday",
        tutor_start_time: "10:00:00",
        tutor_end_time: "12:00:00",
      },
    ];
    tables.tutor_busy_times = [
      {
        tutor_id: "t-clash",
        day_of_week: 1, // Monday
        start_time: "11:00:00",
        end_time: "13:00:00",
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-clash",
        tutor_id: "t-clash",
        course_id: 1,
        status: "pending",
        tutor_mark: 80,
        Availability: true,
      },
      {
        id: "app-clear",
        tutor_id: "t-clear",
        course_id: 1,
        status: "pending",
        tutor_mark: 80,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].tutor_id).toBe("t-clear");
    expect(res.body.skipped.some((s) => s.tutorId === "t-clash")).toBe(true);
  });

  test("a higher mark still wins even with a timetable clash", async () => {
    tables.courses = [
      {
        id: 1,
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
        Day_of_tut: "Monday",
        tutor_start_time: "10:00:00",
        tutor_end_time: "12:00:00",
      },
    ];
    tables.tutor_busy_times = [
      {
        tutor_id: "t-clash",
        day_of_week: 1,
        start_time: "11:00:00",
        end_time: "13:00:00",
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-clash",
        tutor_id: "t-clash",
        course_id: 1,
        status: "pending",
        tutor_mark: 95,
        Availability: true,
      },
      {
        id: "app-clear",
        tutor_id: "t-clear",
        course_id: 1,
        status: "pending",
        tutor_mark: 61,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    expect(res.body.assignments[0].tutor_id).toBe("t-clash");
    expect(res.body.assignments[0].explanation).toContain("timetable clash");
  });

  test("explains why an eligible-but-outranked applicant wasn't picked", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-hi",
        tutor_id: "t-hi",
        course_id: 1,
        status: "pending",
        tutor_mark: 90,
        Availability: true,
      },
      {
        id: "app-lo",
        tutor_id: "t-lo",
        course_id: 1,
        status: "pending",
        tutor_mark: 70,
        Availability: true,
      },
    ];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/auto-allocate")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([
      expect.objectContaining({
        tutorId: "t-lo",
        courseId: 1,
        reason: expect.stringContaining("higher-ranked applicants"),
      }),
    ]);
  });
});

describe("GET /api/allocation-drafts/:id", () => {
  test("404s for a draft that doesn't exist", async () => {
    const res = await request(buildApp()).get("/api/allocation-drafts/999");
    expect(res.status).toBe(404);
  });

  test("returns the draft and its enriched assignments", async () => {
    tables.allocation_drafts = [
      { id: 1, name: "Test draft", created_by: "organiser-1", status: "draft" },
    ];
    tables.courses = [{ id: 5, course_code: "C5", course_name: "Five" }];
    tables.tutors = [{ id: "t1", name: "Bob", email: "bob@example.com" }];
    tables.allocation_draft_assignments = [
      {
        id: 1,
        draft_id: 1,
        tutor_id: "t1",
        course_id: 5,
        explanation: "x",
        locked: false,
      },
    ];

    const res = await request(buildApp()).get("/api/allocation-drafts/1");

    expect(res.status).toBe(200);
    expect(res.body.draft.name).toBe("Test draft");
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].tutor.name).toBe("Bob");
    expect(res.body.assignments[0].course.course_code).toBe("C5");
  });
});

describe("GET /api/allocation-drafts", () => {
  test("lists drafts newest first with an assignment count each", async () => {
    tables.allocation_drafts = [
      {
        id: 1,
        name: "First",
        status: "published",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        name: "Second",
        status: "draft",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    tables.allocation_draft_assignments = [
      { id: 1, draft_id: 1, tutor_id: "t1", course_id: 1 },
      { id: 2, draft_id: 1, tutor_id: "t2", course_id: 1 },
      { id: 3, draft_id: 2, tutor_id: "t3", course_id: 2 },
    ];

    const res = await request(buildApp()).get("/api/allocation-drafts");

    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id)).toEqual([2, 1]);
    expect(res.body.find((d) => d.id === 1).assignmentCount).toBe(2);
    expect(res.body.find((d) => d.id === 2).assignmentCount).toBe(1);
  });

  test("filters by status", async () => {
    tables.allocation_drafts = [
      { id: 1, status: "published" },
      { id: 2, status: "draft" },
    ];

    const res = await request(buildApp()).get(
      "/api/allocation-drafts?status=draft",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.id)).toEqual([2]);
  });
});

describe("POST /api/allocation-drafts/:id/publish", () => {
  function seedOneReadyAssignment() {
    tables.allocation_drafts = [
      { id: 1, name: "Draft", created_by: "organiser-1", status: "draft" },
    ];
    tables.courses = [
      {
        id: 10,
        tutors_needed: 2,
        no_of_tutors_assigned: 0,
        hours_per_week: 3,
      },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
    ];
    tables.allocation_draft_assignments = [
      {
        id: 100,
        draft_id: 1,
        tutor_id: "t1",
        course_id: 10,
        explanation: "x",
        locked: false,
      },
    ];
  }

  test("requires organiserId", async () => {
    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({});
    expect(res.status).toBe(400);
  });

  test("404s for a draft that doesn't exist", async () => {
    const res = await request(buildApp())
      .post("/api/allocation-drafts/999/publish")
      .send({ organiserId: "organiser-1" });
    expect(res.status).toBe(404);
  });

  test("approves the matching application and bumps the course's count", async () => {
    seedOneReadyAssignment();

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft.status).toBe("published");
    expect(res.body.results).toEqual([{ assignmentId: 100, success: true }]);
    expect(tables.tutor_subject_preference[0].status).toBe("approved");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
  });

  test("records an audit entry for the application and a snapshot entry for the draft", async () => {
    seedOneReadyAssignment();

    await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    const appEntry = tables.audit_log.find(
      (e) => e.entity_type === "tutor_subject_preference",
    );
    expect(appEntry).toMatchObject({
      entity_id: "app-1",
      action: "approved",
      actor_id: "organiser-1",
      before: { status: "pending" },
    });

    const draftEntry = tables.audit_log.find(
      (e) => e.entity_type === "allocation_draft",
    );
    expect(draftEntry).toMatchObject({
      entity_id: "1",
      action: "published",
    });
    expect(draftEntry.before.assignments).toEqual([
      { applicationId: "app-1", courseId: 10, previousStatus: "pending" },
    ]);
  });

  test("refuses to publish a draft that's already published", async () => {
    seedOneReadyAssignment();
    tables.allocation_drafts[0].status = "published";

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(409);
  });

  test("excludeAssignmentIds skips a specific proposed row", async () => {
    seedOneReadyAssignment();

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1", excludeAssignmentIds: [100] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { assignmentId: 100, success: false, reason: "excluded" },
    ]);
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("skips an assignment whose application isn't pending any more", async () => {
    seedOneReadyAssignment();
    tables.tutor_subject_preference[0].status = "rejected";

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("skips an assignment whose course has since filled up", async () => {
    seedOneReadyAssignment();
    tables.courses[0].no_of_tutors_assigned = 2; // already at tutors_needed

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({
      success: false,
      reason: "course is now full",
    });
  });

  test("skips an assignment that would now put the tutor over their hour cap", async () => {
    seedOneReadyAssignment();
    tables.tutors[0].weekly_hour_cap = 10;
    // Approved for another course worth 8 hrs since the draft was proposed;
    // +3 for this one would be 11, over the cap.
    tables.tutor_subject_preference.push({
      id: "app-other",
      tutor_id: "t1",
      course_id: 99,
      status: "approved",
      courses: { hours_per_week: 8 },
    });

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: false });
    expect(res.body.results[0].reason).toContain("over their cap");
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });
});

describe("GET /api/allocation-drafts/:id/compare", () => {
  function seedDraftAssignments(assignments, overrides = {}) {
    tables.allocation_drafts = [
      { id: 1, name: "Draft", created_by: "organiser-1", status: "draft" },
    ];
    tables.courses = overrides.courses ?? [
      {
        id: 10,
        course_code: "COMS1000",
        course_name: "Intro",
        tutors_needed: 2,
        no_of_tutors_assigned: 0,
        hours_per_week: 3,
      },
    ];
    tables.tutors = overrides.tutors ?? [
      { id: "t1", name: "Alice", weekly_hour_cap: null },
    ];
    tables.tutor_subject_preference = overrides.applications ?? [
      { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
    ];
    tables.allocation_draft_assignments = assignments;
  }

  test("400s for an invalid draft id", async () => {
    const res = await request(buildApp()).get(
      "/api/allocation-drafts/nope/compare",
    );
    expect(res.status).toBe(400);
  });

  test("404s for a draft that doesn't exist", async () => {
    const res = await request(buildApp()).get(
      "/api/allocation-drafts/999/compare",
    );
    expect(res.status).toBe(404);
  });

  test("reports an assignment as still applicable when nothing has changed", async () => {
    seedDraftAssignments([
      {
        id: 100,
        draft_id: 1,
        tutor_id: "t1",
        course_id: 10,
        explanation: "x",
        locked: false,
      },
    ]);

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ willApply: 1, cannotApply: 0 });
    expect(res.body.assignments[0]).toMatchObject({
      id: 100,
      willApply: true,
      reason: null,
      currentStatus: "pending",
      projectedHours: null,
      cap: null,
    });
    expect(res.body.assignments[0].tutor.name).toBe("Alice");
    expect(res.body.assignments[0].course.course_code).toBe("COMS1000");
  });

  test("projects the tutor's hours against their cap when they have one", async () => {
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
      ],
      { tutors: [{ id: "t1", weekly_hour_cap: 10 }] },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({
      willApply: true,
      projectedHours: 3,
      cap: 10,
    });
  });

  test("marks an assignment whose application isn't pending any more, with its current status", async () => {
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
      ],
      {
        applications: [
          { id: "app-1", tutor_id: "t1", course_id: 10, status: "rejected" },
        ],
      },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({
      willApply: false,
      reason: "no longer a pending application",
      currentStatus: "rejected",
    });
    expect(res.body.summary).toEqual({ willApply: 0, cannotApply: 1 });
  });

  test("marks an assignment whose course has since filled up", async () => {
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
      ],
      {
        courses: [
          {
            id: 10,
            course_code: "COMS1000",
            course_name: "Intro",
            tutors_needed: 2,
            no_of_tutors_assigned: 2,
            hours_per_week: 3,
          },
        ],
      },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({
      willApply: false,
      reason: "course is now full",
    });
  });

  test("marks an assignment that would now put the tutor over their hour cap, with the projected total", async () => {
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
      ],
      {
        tutors: [{ id: "t1", weekly_hour_cap: 10 }],
        applications: [
          { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
          {
            id: "app-other",
            tutor_id: "t1",
            course_id: 99,
            status: "approved",
            courses: { hours_per_week: 8 },
          },
        ],
      },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({
      willApply: false,
      reason: "would put the tutor at 11/10 hrs/week, over their cap",
      projectedHours: 11,
      cap: 10,
    });
  });

  test("stacks the draft's own hours per tutor, as publishing would", async () => {
    // Two proposals for the same tutor, 6 hrs each, cap 10 — the first
    // lands (6/10), the second would take them to 12/10.
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
        {
          id: 101,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 11,
          explanation: "y",
          locked: false,
        },
      ],
      {
        courses: [
          {
            id: 10,
            course_code: "C1",
            course_name: "One",
            tutors_needed: 1,
            no_of_tutors_assigned: 0,
            hours_per_week: 6,
          },
          {
            id: 11,
            course_code: "C2",
            course_name: "Two",
            tutors_needed: 1,
            no_of_tutors_assigned: 0,
            hours_per_week: 6,
          },
        ],
        tutors: [{ id: "t1", weekly_hour_cap: 10 }],
        applications: [
          { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
          { id: "app-2", tutor_id: "t1", course_id: 11, status: "pending" },
        ],
      },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({
      willApply: true,
      projectedHours: 6,
    });
    expect(res.body.assignments[1]).toMatchObject({
      willApply: false,
      reason: "would put the tutor at 12/10 hrs/week, over their cap",
    });
  });

  test("two proposals for the same course compete for its last slot, as publishing would", async () => {
    // One open slot, two proposed tutors — the first lands, the second
    // finds the course full.
    seedDraftAssignments(
      [
        {
          id: 100,
          draft_id: 1,
          tutor_id: "t1",
          course_id: 10,
          explanation: "x",
          locked: false,
        },
        {
          id: 101,
          draft_id: 1,
          tutor_id: "t2",
          course_id: 10,
          explanation: "y",
          locked: false,
        },
      ],
      {
        courses: [
          {
            id: 10,
            course_code: "COMS1000",
            course_name: "Intro",
            tutors_needed: 1,
            no_of_tutors_assigned: 0,
            hours_per_week: 3,
          },
        ],
        tutors: [
          { id: "t1", weekly_hour_cap: null },
          { id: "t2", weekly_hour_cap: null },
        ],
        applications: [
          { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
          { id: "app-2", tutor_id: "t2", course_id: 10, status: "pending" },
        ],
      },
    );

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.assignments[0]).toMatchObject({ willApply: true });
    expect(res.body.assignments[1]).toMatchObject({
      willApply: false,
      reason: "course is now full",
    });
  });

  test("returns an empty comparison for a draft with no assignments", async () => {
    seedDraftAssignments([]);

    const res = await request(buildApp()).get(
      "/api/allocation-drafts/1/compare",
    );

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ willApply: 0, cannotApply: 0 });
    expect(res.body.assignments).toEqual([]);
  });
});

describe("POST /api/allocation-drafts/:id/restore", () => {
  async function publishOneAssignment(app) {
    tables.allocation_drafts = [
      { id: 1, name: "Draft", created_by: "organiser-1", status: "draft" },
    ];
    tables.courses = [
      {
        id: 10,
        tutors_needed: 2,
        no_of_tutors_assigned: 0,
        hours_per_week: 3,
      },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", tutor_id: "t1", course_id: 10, status: "pending" },
    ];
    tables.allocation_draft_assignments = [
      {
        id: 100,
        draft_id: 1,
        tutor_id: "t1",
        course_id: 10,
        explanation: "x",
        locked: false,
      },
    ];

    await request(app)
      .post("/api/allocation-drafts/1/publish")
      .send({ organiserId: "organiser-1" });
  }

  test("requires organiserId", async () => {
    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/restore")
      .send({});
    expect(res.status).toBe(400);
  });

  test("404s for a draft that doesn't exist", async () => {
    const res = await request(buildApp())
      .post("/api/allocation-drafts/999/restore")
      .send({ organiserId: "organiser-1" });
    expect(res.status).toBe(404);
  });

  test("refuses to restore a draft that was never published", async () => {
    tables.allocation_drafts = [{ id: 1, status: "draft" }];

    const res = await request(buildApp())
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(409);
  });

  test("reverts the application status and decrements the course's count", async () => {
    const app = buildApp();
    await publishOneAssignment(app);

    const res = await request(app)
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.draft.status).toBe("reverted");
    expect(res.body.results).toEqual([
      { applicationId: "app-1", success: true },
    ]);
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("records an audit entry for the reverted application and the draft", async () => {
    const app = buildApp();
    await publishOneAssignment(app);

    await request(app)
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    const restoreEntry = tables.audit_log.find(
      (e) =>
        e.entity_type === "tutor_subject_preference" && e.action === "restored",
    );
    expect(restoreEntry).toMatchObject({
      entity_id: "app-1",
      actor_id: "organiser-1",
      after: { status: "pending" },
    });

    const draftEntry = tables.audit_log.find(
      (e) => e.entity_type === "allocation_draft" && e.action === "restored",
    );
    expect(draftEntry).toBeTruthy();
  });

  test("can't restore the same draft twice", async () => {
    const app = buildApp();
    await publishOneAssignment(app);
    await request(app)
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    const res = await request(app)
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(409);
  });

  test("leaves an application alone if it was already changed since publish", async () => {
    const app = buildApp();
    await publishOneAssignment(app);
    tables.tutor_subject_preference[0].status = "rejected"; // organiser overrode it manually since

    const res = await request(app)
      .post("/api/allocation-drafts/1/restore")
      .send({ organiserId: "organiser-1" });

    expect(res.status).toBe(200);
    expect(res.body.results[0].success).toBe(false);
    expect(tables.tutor_subject_preference[0].status).toBe("rejected");
  });
});
