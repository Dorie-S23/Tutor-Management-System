const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
// The factory proxies to whatever `mockSupabase` currently points at, which
// beforeEach() reassigns for every test.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const tutorApplicationsRouter = require("./tutorApplications");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tutor-applications", tutorApplicationsRouter);
  return app;
}

beforeEach(() => {
  tables = {
    courses: [],
    tutor_subject_preference: [],
    tutors: [],
    allocation_overrides: [],
    audit_log: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/tutor-applications/obvious-fill", () => {
  test("includes a course only when every eligible pending applicant fits in its remaining slots", async () => {
    tables.courses = [
      // 1 remaining slot, exactly 1 eligible applicant -> obvious fill
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro to Programming",
        min_mark: 60,
        tutors_needed: 2,
        no_of_tutors_assigned: 1,
      },
      // 1 remaining slot, 2 eligible applicants -> needs a judgment call, excluded
      {
        id: 2,
        course_code: "COMS2000",
        course_name: "Data Structures",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
      // no remaining slots -> excluded
      {
        id: 3,
        course_code: "COMS3000",
        course_name: "Already Full",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 1,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "a1",
        course_id: 1,
        tutor_mark: 70,
        Availability: true,
        Tutor_name: "Alice",
        status: "pending",
      },
      {
        id: "a2",
        course_id: 1,
        tutor_mark: 40,
        Availability: true,
        Tutor_name: "Bob",
        status: "pending",
      }, // below min_mark
      {
        id: "a3",
        course_id: 2,
        tutor_mark: 80,
        Availability: true,
        Tutor_name: "Cara",
        status: "pending",
      },
      {
        id: "a4",
        course_id: 2,
        tutor_mark: 90,
        Availability: true,
        Tutor_name: "Dan",
        status: "pending",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/tutor-applications/obvious-fill",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        course: { id: 1, code: "COMS1000", name: "Intro to Programming" },
        applications: [{ id: "a1", tutorName: "Alice", mark: 70 }],
      },
    ]);
  });

  test("excludes an applicant who isn't free at the tutorial time even if their mark qualifies", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro to Programming",
        min_mark: 60,
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "a1",
        course_id: 1,
        tutor_mark: 90,
        Availability: false,
        Tutor_name: "Alice",
        status: "pending",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/tutor-applications/obvious-fill",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("POST /api/tutor-applications/bulk-approve", () => {
  test("rejects a missing or empty applicationIds array", async () => {
    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({});

    expect(res.status).toBe(400);
  });

  test("approves what fits and reports the rest as failed once a course fills up, without over-filling it", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, Tutor_name: "Alice" },
      { id: "app-2", status: "pending", course_id: 10, Tutor_name: "Bob" },
    ];

    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1", "app-2"] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: "app-1", success: true, name: "Alice" },
      {
        id: "app-2",
        success: false,
        error: "This course already has all the tutors it needs",
      },
    ]);

    const course = tables.courses.find((c) => c.id === 10);
    expect(course.no_of_tutors_assigned).toBe(2);

    const approved = tables.tutor_subject_preference.find(
      (a) => a.id === "app-1",
    );
    expect(approved.status).toBe("approved");
    const stillPending = tables.tutor_subject_preference.find(
      (a) => a.id === "app-2",
    );
    expect(stillPending.status).toBe("pending");
  });

  test("reports a not-found error for an unknown application id instead of throwing", async () => {
    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["missing"] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: "missing", success: false, error: "Application not found" },
    ]);
  });

  test("is a no-op success for an application that's already approved", async () => {
    tables.courses = [{ id: 10, tutors_needed: 1, no_of_tutors_assigned: 1 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "approved", course_id: 10, Tutor_name: "Alice" },
    ];

    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1"] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: "app-1", success: true, name: "Alice" },
    ]);
    // Shouldn't double-count an already-approved application against capacity.
    expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
  });
});

describe("PATCH /api/tutor-applications/:id", () => {
  test("rejects a status that isn't pending, approved or rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "maybe" });

    expect(res.status).toBe(400);
  });

  test("returns 404 for an application that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/tutor-applications/missing")
      .send({ status: "approved" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Application not found");
  });

  test("approving a pending application bumps the course's assigned-tutor count", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 2, no_of_tutors_assigned: 0, hours_per_week: 3 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
  });

  test("rejecting a previously approved application frees up the course's slot", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 2, no_of_tutors_assigned: 1, hours_per_week: 3 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("moving a pending application to rejected doesn't touch the course's slot count", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("blocks approval that would exceed the course's tutor capacity", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 1, no_of_tutors_assigned: 1, hours_per_week: 3 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "This course already has all the tutors it needs",
    );
    // Nothing should have been written.
    expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
  });

  test("blocks approval that would push the tutor over their weekly hour cap", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 5, no_of_tutors_assigned: 0, hours_per_week: 5 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: 6 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
      // Another approved course for the same tutor, already worth 4 hrs —
      // adding this 5-hr course would put them at 9, over their 6-hr cap.
      // fakeSupabase doesn't do real joins, so the "courses" field is
      // seeded directly to stand in for the embedded select.
      {
        id: "app-0",
        status: "approved",
        course_id: 99,
        tutor_id: "t1",
        courses: { hours_per_week: 4 },
      },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "This would put the tutor at 9 hrs/week, over their 6 hr cap",
    );
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
  });

  test("allows approval right up to the tutor's weekly hour cap", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 5, no_of_tutors_assigned: 0, hours_per_week: 2 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: 6 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
      {
        id: "app-0",
        status: "approved",
        course_id: 99,
        tutor_id: "t1",
        courses: { hours_per_week: 4 },
      },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  test("an override without organiserId is rejected before anything is written", async () => {
    tables.courses = [{ id: 10, tutors_needed: 1, no_of_tutors_assigned: 1 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved", override: true, reason: "urgent" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "organiserId is required to record an override",
    );
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
  });

  test("an override with a blank reason is rejected", async () => {
    tables.courses = [{ id: 10, tutors_needed: 1, no_of_tutors_assigned: 1 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "approved",
        override: true,
        organiserId: "org-1",
        reason: "   ",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A reason is required to record an override");
  });

  test("an override past a full course logs the bypass to allocation_overrides and still approves", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 1, no_of_tutors_assigned: 1, hours_per_week: 3 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "approved",
        override: true,
        organiserId: "org-1",
        reason: "Short-staffed this week",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(2);

    expect(tables.allocation_overrides).toHaveLength(1);
    expect(tables.allocation_overrides[0]).toMatchObject({
      organiser_id: "org-1",
      tutor_id: "t1",
      course_id: 10,
      rule_overridden: "course_capacity",
    });
    expect(tables.allocation_overrides[0].reason).toBe(
      "Short-staffed this week (Would be 2/1 tutors assigned)",
    );
  });

  test("an override past both capacity and the hour cap logs one row per bypassed rule", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 1, no_of_tutors_assigned: 1, hours_per_week: 5 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: 4 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "approved",
        override: true,
        organiserId: "org-1",
        reason: "Special case",
      });

    expect(res.status).toBe(200);
    expect(tables.allocation_overrides).toHaveLength(2);
    expect(tables.allocation_overrides.map((o) => o.rule_overridden)).toEqual([
      "course_capacity",
      "weekly_hour_cap",
    ]);
  });

  test("resetting an approved application back to pending frees the course slot without an override", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "pending" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });
});

describe("DELETE /api/tutor-applications/:id", () => {
  test("returns 404 for an application that doesn't exist", async () => {
    const res = await request(buildApp()).delete(
      "/api/tutor-applications/missing",
    );

    expect(res.status).toBe(404);
  });

  test("withdrawing a pending application just removes the row", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp()).delete(
      "/api/tutor-applications/app-1",
    );

    expect(res.status).toBe(204);
    expect(tables.tutor_subject_preference).toHaveLength(0);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("withdrawing an approved application frees the course's slot", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp()).delete(
      "/api/tutor-applications/app-1",
    );

    expect(res.status).toBe(204);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("records a withdrawal in the audit log with the tutor as actor", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
    ];

    await request(buildApp()).delete("/api/tutor-applications/app-1");

    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0]).toMatchObject({
      entity_type: "tutor_subject_preference",
      entity_id: "app-1",
      action: "withdrawn",
      actor_id: "t1",
      before: { status: "approved" },
    });
  });
});

describe("PATCH /api/tutor-applications/:id — audit log", () => {
  test("records an approval with the organiser as actor and the prior status", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 2, no_of_tutors_assigned: 0, hours_per_week: 3 },
    ];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved", organiserId: "organiser-1" });

    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0]).toMatchObject({
      entity_type: "tutor_subject_preference",
      entity_id: "app-1",
      action: "approved",
      actor_id: "organiser-1",
      before: { status: "pending" },
      after: { status: "approved" },
    });
  });

  test("doesn't write an audit entry when the status is invalid", async () => {
    await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "maybe" });

    expect(tables.audit_log).toHaveLength(0);
  });
});

describe("POST /api/tutor-applications/bulk-approve — audit log", () => {
  test("records one audit entry per successfully approved application", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, Tutor_name: "A" },
      { id: "app-2", status: "pending", course_id: 10, Tutor_name: "B" },
    ];

    await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1", "app-2"], organiserId: "organiser-1" });

    expect(tables.audit_log).toHaveLength(2);
    expect(tables.audit_log.map((e) => e.entity_id).sort()).toEqual([
      "app-1",
      "app-2",
    ]);
    expect(tables.audit_log[0]).toMatchObject({
      action: "approved",
      actor_id: "organiser-1",
    });
  });

  test("doesn't write an audit entry for an application that fails to approve", async () => {
    tables.courses = [{ id: 10, tutors_needed: 1, no_of_tutors_assigned: 1 }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, Tutor_name: "A" },
    ];

    await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1"] });

    expect(tables.audit_log).toHaveLength(0);
  });
});
