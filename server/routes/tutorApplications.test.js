const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let storageFiles;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
// The factory proxies to whatever `mockSupabase` currently points at, which
// beforeEach() reassigns for every test.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
  storage: { from: (...args) => mockSupabase.storage.from(...args) },
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
    academic_level_rates: [],
    notifications: [],
    audit_log: [],
    tutor_busy_times: [],
  };
  // The transcripts bucket exists and starts empty; tests whose request
  // should get past the transcript check seed a file into it.
  storageFiles = { transcripts: [] };
  mockSupabase = fakeSupabase(tables, {}, storageFiles);
});

describe("POST /api/tutor-applications", () => {
  beforeEach(() => {
    tables.tutors = [{ id: "tutor-1", name: "Test Tutor" }];
    tables.courses = [
      {
        id: 1,
        course_code: "COMS3300",
        course_name: "Honours Project",
        course_level: 4, // honours
      },
    ];
    // The "accepts" tests below flow through the transcript check.
    storageFiles.transcripts.push("tutor-1/transcript.pdf");
  });

  function validApplication(overrides = {}) {
    return {
      tutorId: "tutor-1",
      courseId: 1,
      mark: 75,
      availability: true,
      academicLevel: "honours",
      ...overrides,
    };
  }

  test("rejects a course with no course_level set yet", async () => {
    tables.courses[0].course_level = null;

    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication());

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/doesn't have a year level set yet/);
  });

  test("rejects a tutor below the course's minimum level", async () => {
    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication({ academicLevel: "third_year" }));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "You need to be at Honours level or higher to tutor COMS3300.",
    );
  });

  test("accepts a tutor exactly at the course's minimum level", async () => {
    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication({ academicLevel: "honours" }));

    expect(res.status).toBe(201);
  });

  test("accepts a tutor above the course's minimum level", async () => {
    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication({ academicLevel: "phd" }));

    expect(res.status).toBe(201);
  });

  test("refuses an application until a transcript is on file", async () => {
    storageFiles.transcripts.length = 0;

    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication());

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "Please upload your transcript before applying.",
    );
    expect(tables.tutor_subject_preference).toHaveLength(0);
  });

  test("answers 502 when the transcript storage lookup itself fails", async () => {
    mockSupabase.storage.from = () => ({
      list: async () => ({
        data: null,
        error: { message: "FetchError: request to Supabase failed" },
      }),
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp())
      .post("/api/tutor-applications")
      .send(validApplication());

    errorSpy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unavailable/);
    expect(tables.tutor_subject_preference).toHaveLength(0);
  });
});

describe("GET /api/tutor-applications", () => {
  test("attaches hourly_rate to the embedded tutor, derived from their academic_level", async () => {
    tables.tutor_subject_preference = [
      {
        id: 1,
        tutor_id: "tutor-1",
        course_id: 1,
        tutor_mark: 80,
        Availability: true,
        tutors: {
          name: "Test Tutor",
          email: "tutor@wits.ac.za",
          academic_level: "honours",
          weekly_hour_cap: 10,
        },
        courses: { course_code: "COMS3300", course_name: "Honours Project" },
      },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
    ];

    const res = await request(buildApp())
      .get("/api/tutor-applications")
      .query({ tutorId: "tutor-1" });

    expect(res.status).toBe(200);
    expect(res.body[0].tutors.hourly_rate).toBe(150);
  });

  test("leaves hourly_rate null when the tutor has no academic_level", async () => {
    tables.tutor_subject_preference = [
      {
        id: 1,
        tutor_id: "tutor-1",
        course_id: 1,
        tutors: { name: "Test Tutor" },
        courses: { course_code: "COMS3300" },
      },
    ];

    const res = await request(buildApp())
      .get("/api/tutor-applications")
      .query({ tutorId: "tutor-1" });

    expect(res.status).toBe(200);
    expect(res.body[0].tutors.hourly_rate).toBeNull();
  });
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

  test("notifies each tutor it actually approved, not the ones it couldn't", async () => {
    tables.courses = [
      {
        id: 10,
        course_code: "COMS2000",
        course_name: "Data Structures",
        tutors_needed: 1,
        no_of_tutors_assigned: 0,
      },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        status: "pending",
        course_id: 10,
        tutor_id: "t1",
        Tutor_name: "Alice",
      },
      {
        id: "app-2",
        status: "pending",
        course_id: 10,
        tutor_id: "t2",
        Tutor_name: "Bob",
      },
    ];

    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1", "app-2"] });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]).toMatchObject({
      user_id: "t1",
      type: "application_status",
    });
    expect(tables.notifications[0].message).toContain("COMS2000");
  });

  test("reports a conflict for an application that's no longer pending instead of resurrecting it", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutor_subject_preference = [
      // The obvious-fill list showed this as pending; someone rejected it
      // in another tab since.
      { id: "app-1", status: "rejected", course_id: 10, Tutor_name: "Alice" },
    ];

    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1"] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      {
        id: "app-1",
        success: false,
        error: "Someone else already changed this application",
      },
    ]);
    // The rejection stands; the course and the audit trail are untouched.
    expect(tables.tutor_subject_preference[0].status).toBe("rejected");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
    expect(tables.audit_log).toHaveLength(0);
  });

  test("fails just the items that changed mid-request and rolls their counter bumps back", async () => {
    tables.courses = [
      { id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 },
      { id: 11, tutors_needed: 1, no_of_tutors_assigned: 0 },
    ];
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        status: "pending",
        course_id: 10,
        tutor_id: "t1",
        Tutor_name: "Alice",
      },
      {
        id: "app-2",
        status: "pending",
        course_id: 11,
        tutor_id: "t2",
        Tutor_name: "Bob",
      },
    ];

    // Someone else rejects the first application right before its guarded
    // status write lands; the second must still go through.
    mockSupabase = fakeSupabase(
      tables,
      {},
      {},
      {
        onBeforeResolve: (table, operation) => {
          if (table === "tutor_subject_preference" && operation === "update") {
            const alice = tables.tutor_subject_preference[0];
            if (alice.status === "pending") {
              alice.status = "rejected";
            }
          }
        },
      },
    );

    const res = await request(buildApp())
      .post("/api/tutor-applications/bulk-approve")
      .send({ applicationIds: ["app-1", "app-2"] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      {
        id: "app-1",
        success: false,
        error: "Someone else already changed this application",
      },
      { id: "app-2", success: true, name: "Bob" },
    ]);
    expect(tables.tutor_subject_preference[0].status).toBe("rejected");
    expect(tables.tutor_subject_preference[1].status).toBe("approved");
    // Only app-2's bump stuck; app-1's was rolled back when its write
    // lost the race.
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
    expect(tables.courses[1].no_of_tutors_assigned).toBe(1);
    expect(tables.audit_log).toHaveLength(1);
    expect(tables.audit_log[0].entity_id).toBe("app-2");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0].user_id).toBe("t2");
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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "pending",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Application not found");
  });

  test("requires expectedStatus — the status the client last saw", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const missing = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "approved", approvalReason: "Great fit" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe(
      "expectedStatus is required and must be pending, approved or rejected",
    );

    const invalid = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "unknown",
      });
    expect(invalid.status).toBe(400);

    // Neither rejected request may have written anything.
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
    expect(tables.audit_log).toHaveLength(0);
  });

  test("returns 409 without touching anything when the application already moved on", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      // Approved by another organiser since the client last saw it pending.
      { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "rejected",
        rejectionReason: "Changed my mind",
        expectedStatus: "pending",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "Someone else already changed this application — reload to see the latest state.",
    );
    // The other organiser's approval stands; nothing was overwritten or
    // even written — no counter change, no audit entry, no notification.
    expect(tables.tutor_subject_preference[0].status).toBe("approved");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
    expect(tables.audit_log).toHaveLength(0);
    expect(tables.notifications).toHaveLength(0);
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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "pending",
      });

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
      .send({
        status: "rejected",
        rejectionReason: "No longer needed",
        expectedStatus: "approved",
      });

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
      .send({
        status: "rejected",
        rejectionReason: "No longer needed",
        expectedStatus: "pending",
      });

    expect(res.status).toBe(200);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("rejecting stores the reason, rejecting without one is a 400", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 0 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
    ];

    const missingReason = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "rejected" });
    expect(missingReason.status).toBe(400);
    expect(tables.tutor_subject_preference[0].status).toBe("pending");

    const withReason = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({
        status: "rejected",
        rejectionReason: "Mark below cutoff",
        expectedStatus: "pending",
      });
    expect(withReason.status).toBe(200);
    expect(tables.tutor_subject_preference[0].rejection_reason).toBe(
      "Mark below cutoff",
    );
  });

  test("approving without a reason is rejected with a 400", async () => {
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

    expect(res.status).toBe(400);
    expect(tables.tutor_subject_preference[0].status).toBe("pending");
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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "pending",
      });

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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "pending",
      });

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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        expectedStatus: "pending",
      });

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
      .send({
        status: "approved",
        approvalReason: "Great fit",
        override: true,
        reason: "urgent",
      });

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
        approvalReason: "Great fit",
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
        approvalReason: "Great fit",
        override: true,
        organiserId: "org-1",
        reason: "Short-staffed this week",
        expectedStatus: "pending",
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
        approvalReason: "Great fit",
        override: true,
        organiserId: "org-1",
        reason: "Special case",
        expectedStatus: "pending",
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
      .send({ status: "pending", expectedStatus: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(tables.courses[0].no_of_tutors_assigned).toBe(0);
  });

  test("a locked application's status can't be changed", async () => {
    tables.courses = [{ id: 10, tutors_needed: 2, no_of_tutors_assigned: 1 }];
    tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        status: "approved",
        course_id: 10,
        tutor_id: "t1",
        locked: true,
      },
    ];

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1")
      .send({ status: "pending", expectedStatus: "approved" });

    expect(res.status).toBe(409);
    expect(tables.tutor_subject_preference[0].status).toBe("approved");
  });

  describe("when another organiser writes between the read and the write", () => {
    test("refuses to overwrite a status that changed mid-request, and rolls the counter back", async () => {
      tables.courses = [
        {
          id: 10,
          tutors_needed: 2,
          no_of_tutors_assigned: 1,
          hours_per_week: 3,
        },
      ];
      tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
      tables.tutor_subject_preference = [
        { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
      ];

      // Stand-in for a second organiser: just before the guarded status
      // write lands, someone else rejects the same application.
      mockSupabase = fakeSupabase(
        tables,
        {},
        {},
        {
          onBeforeResolve: (table, operation) => {
            if (
              table === "tutor_subject_preference" &&
              operation === "update"
            ) {
              tables.tutor_subject_preference[0].status = "rejected";
            }
          },
        },
      );

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({
          status: "approved",
          approvalReason: "Strong mark",
          expectedStatus: "pending",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        "Someone else already changed this application — reload to see the latest state.",
      );
      // The other organiser's rejection stands, the counter bump this
      // request made on the way was rolled back, and nothing was recorded.
      expect(tables.tutor_subject_preference[0].status).toBe("rejected");
      expect(tables.courses[0].no_of_tutors_assigned).toBe(1);
      expect(tables.audit_log).toHaveLength(0);
      expect(tables.notifications).toHaveLength(0);
    });

    test("refuses the counter bump when the course count changed mid-request", async () => {
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
        { id: "app-1", status: "pending", course_id: 10, tutor_id: "t1" },
      ];

      // Another approval for the same course slips in between this route's
      // course read and its guarded counter bump.
      mockSupabase = fakeSupabase(
        tables,
        {},
        {},
        {
          onBeforeResolve: (table, operation) => {
            if (table === "courses" && operation === "update") {
              tables.courses[0].no_of_tutors_assigned = 7;
            }
          },
        },
      );

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({
          status: "approved",
          approvalReason: "Strong mark",
          expectedStatus: "pending",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(
        "Someone else just changed this course's assignments — reload to see the latest state.",
      );
      // This request wrote nothing at all.
      expect(tables.tutor_subject_preference[0].status).toBe("pending");
      expect(tables.courses[0].no_of_tutors_assigned).toBe(7);
      expect(tables.audit_log).toHaveLength(0);
      expect(tables.notifications).toHaveLength(0);
    });
  });

  // The notification fan-out is fire-and-forget (not awaited before the
  // route responds), so these flush a macrotask after the request resolves
  // to let it land before asserting on the fake table.
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe("notifying the tutor of the outcome", () => {
    test("approving notifies the tutor", async () => {
      tables.courses = [
        {
          id: 10,
          course_code: "COMS2000",
          course_name: "Data Structures",
          tutors_needed: 2,
          no_of_tutors_assigned: 0,
          hours_per_week: 3,
        },
      ];
      tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
      tables.tutor_subject_preference = [
        {
          id: "app-1",
          status: "pending",
          course_id: 10,
          tutor_id: "t1",
          // fakeSupabase doesn't do real joins — seed the embedded shape
          // the route's .select("*, courses(...)") expects back directly.
          courses: { course_code: "COMS2000", course_name: "Data Structures" },
        },
      ];

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({
          status: "approved",
          approvalReason: "Great fit",
          expectedStatus: "pending",
        });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(1);
      expect(tables.notifications[0]).toMatchObject({
        user_id: "t1",
        type: "application_status",
        related_entity: "application",
        related_id: "app-1",
        read: false,
      });
      expect(tables.notifications[0].message).toContain("COMS2000");
    });

    test("rejecting a pending application notifies the tutor it was rejected, not removed", async () => {
      tables.courses = [{ id: 10, course_code: "COMS2000" }];
      tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
      tables.tutor_subject_preference = [
        {
          id: "app-1",
          status: "pending",
          course_id: 10,
          tutor_id: "t1",
          courses: { course_code: "COMS2000" },
        },
      ];

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({
          status: "rejected",
          rejectionReason: "Mark too low",
          expectedStatus: "pending",
        });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toMatch(/was rejected/);
      expect(tables.notifications[0].message).toContain("Mark too low");
    });

    test("rejecting a previously-approved application tells the tutor they were removed", async () => {
      tables.courses = [
        { id: 10, course_code: "COMS2000", no_of_tutors_assigned: 1 },
      ];
      tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
      tables.tutor_subject_preference = [
        { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
      ];

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({
          status: "rejected",
          rejectionReason: "Course cancelled",
          expectedStatus: "approved",
        });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toMatch(/removed from/);
    });

    test("resetting to pending doesn't notify anyone", async () => {
      tables.courses = [{ id: 10, course_code: "COMS2000" }];
      tables.tutors = [{ id: "t1", weekly_hour_cap: null }];
      tables.tutor_subject_preference = [
        { id: "app-1", status: "approved", course_id: 10, tutor_id: "t1" },
      ];

      const res = await request(buildApp())
        .patch("/api/tutor-applications/app-1")
        .send({ status: "pending", expectedStatus: "approved" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });
  });
});

describe("PATCH /api/tutor-applications/:id/lock", () => {
  beforeEach(() => {
    tables.tutor_subject_preference = [
      {
        id: "app-1",
        status: "approved",
        course_id: 10,
        tutor_id: "t1",
        locked: false,
      },
    ];
  });

  test("locks an approved application", async () => {
    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1/lock")
      .send({ locked: true });

    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(true);
    expect(tables.tutor_subject_preference[0].locked).toBe(true);
  });

  test("rejects anything other than locked: true", async () => {
    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1/lock")
      .send({ locked: false });

    expect(res.status).toBe(400);
    expect(tables.tutor_subject_preference[0].locked).toBe(false);
  });

  test("refuses to lock an application that isn't approved", async () => {
    tables.tutor_subject_preference[0].status = "pending";

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1/lock")
      .send({ locked: true });

    expect(res.status).toBe(409);
    expect(tables.tutor_subject_preference[0].locked).toBe(false);
  });

  test("refuses to lock an application that's already locked", async () => {
    tables.tutor_subject_preference[0].locked = true;

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1/lock")
      .send({ locked: true });

    expect(res.status).toBe(409);
  });

  test("404s for an application that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/tutor-applications/missing/lock")
      .send({ locked: true });

    expect(res.status).toBe(404);
  });

  test("returns 409 if someone else locks it between the read and the write", async () => {
    // The other organiser's lock lands right before this route's guarded
    // update resolves.
    mockSupabase = fakeSupabase(
      tables,
      {},
      {},
      {
        onBeforeResolve: (table, operation) => {
          if (table === "tutor_subject_preference" && operation === "update") {
            tables.tutor_subject_preference[0].locked = true;
          }
        },
      },
    );

    const res = await request(buildApp())
      .patch("/api/tutor-applications/app-1/lock")
      .send({ locked: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      "This assignment was just changed by someone else — reload to see the latest state.",
    );
    // The other organiser's lock stands.
    expect(tables.tutor_subject_preference[0].locked).toBe(true);
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

    await request(buildApp()).patch("/api/tutor-applications/app-1").send({
      status: "approved",
      approvalReason: "Strong mark",
      organiserId: "organiser-1",
      expectedStatus: "pending",
    });

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

// Multi-objective balancing: the ranked GET blends the competing ranking
// objectives (mark, availability, timetable fit, seniority, spare hours)
// with a ?preset= of weights. fakeSupabase doesn't join, so each application
// row carries its nested tutors/courses objects directly.
describe("GET /api/tutor-applications (ranked)", () => {
  // Ada: strongest on paper, but already carries 8 of her 10 weekly hours.
  // Ben: a slightly weaker mark, fully fresh.
  // Cara: weaker than Ada on every objective (mark, availability, timetable
  // fit, level, headroom) — Pareto-dominated by both.
  function seedApplicants() {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro to Programming",
        min_mark: 60,
        hours_per_week: 3,
        tutors_needed: 2,
        no_of_tutors_assigned: 0,
        Day_of_tut: "Monday",
        tutor_start_time: "10:00",
        tutor_end_time: "11:00",
      },
    ];
    tables.tutor_busy_times = [
      // Cara's Monday overlap with the course's tutorial slot.
      {
        tutor_id: "t3",
        title: "Lab duty",
        day_of_week: "Monday",
        start_time: "10:00",
        end_time: "11:00",
      },
    ];
    // The route reads courseId from the query string ("1"), and
    // fakeSupabase's eq is strict, so the seeded course_id is a string too.
    tables.tutor_subject_preference = [
      {
        id: "a1",
        course_id: "1",
        tutor_id: "t1",
        tutor_mark: 90,
        Availability: true,
        Tutor_name: "Ada",
        status: "pending",
        tutors: { academic_level: "third_year", weekly_hour_cap: 10 },
        courses: { course_code: "COMS1000", hours_per_week: 3 },
      },
      {
        id: "a2",
        course_id: "1",
        tutor_id: "t2",
        tutor_mark: 75,
        Availability: true,
        Tutor_name: "Ben",
        status: "pending",
        tutors: { academic_level: "third_year", weekly_hour_cap: 10 },
        courses: { course_code: "COMS1000", hours_per_week: 3 },
      },
      {
        id: "a3",
        course_id: "1",
        tutor_id: "t3",
        tutor_mark: 70,
        Availability: false,
        Tutor_name: "Cara",
        status: "pending",
        tutors: { academic_level: "second_year", weekly_hour_cap: 10 },
        courses: { course_code: "COMS1000", hours_per_week: 3 },
      },
      // Ada's existing approved course elsewhere: 8 hrs/week of load.
      {
        id: "a1-elsewhere",
        course_id: "99",
        tutor_id: "t1",
        tutor_mark: 85,
        Availability: true,
        Tutor_name: "Ada",
        status: "approved",
        courses: {
          course_code: "COMS2000",
          hours_per_week: 8,
          Day_of_tut: null,
        },
      },
      // Cara's existing approved course elsewhere: 9 hrs/week of load.
      {
        id: "a3-elsewhere",
        course_id: "98",
        tutor_id: "t3",
        tutor_mark: 80,
        Availability: true,
        Tutor_name: "Cara",
        status: "approved",
        courses: {
          course_code: "COMS3000",
          hours_per_week: 9,
          Day_of_tut: null,
        },
      },
    ];
  }

  test("defaults to merit-first ordering, matching the historical ranking", async () => {
    seedApplicants();

    const res = await request(buildApp()).get(
      "/api/tutor-applications?courseId=1",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.Tutor_name)).toEqual(["Ada", "Ben", "Cara"]);

    const ada = res.body[0].ranking;
    expect(ada.preset).toBe("merit");
    expect(ada.mark).toBe(90);
    expect(ada.currentAssignedHours).toBe(8);
    expect(ada.projectedHours).toBe(11);
    expect(ada.objectives).toEqual({
      merit: 0.9,
      availability: 1,
      clashFree: 1,
      seniority: 0.5,
      headroom: 0.2,
    });
    expect(ada.rank).toBe(1);
    expect(ada.meritRank).toBe(1);
    expect(ada.paretoDominated).toBe(false);
    expect(ada.tradeoff).toBeNull();

    // Pareto domination is weight-independent: Cara loses to Ada on every
    // objective (weaker mark, unavailable, timetable clash, lower level,
    // less headroom), so she's flagged under the default preset too.
    expect(res.body[2].ranking.paretoDominated).toBe(true);
  });

  test("preset=fairness re-orders toward spare capacity and explains the trade-off", async () => {
    seedApplicants();

    const res = await request(buildApp()).get(
      "/api/tutor-applications?courseId=1&preset=fairness",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((a) => a.Tutor_name)).toEqual(["Ben", "Ada", "Cara"]);

    const ben = res.body[0].ranking;
    expect(ben.preset).toBe("fairness");
    expect(ben.rank).toBe(1);
    expect(ben.meritRank).toBe(2);
    expect(ben.tradeoff).toBe(
      "Merit-first would rank them #2; this balance ranks them #1.",
    );

    const ada = res.body[1].ranking;
    expect(ada.rank).toBe(2);
    expect(ada.meritRank).toBe(1);
    expect(ada.tradeoff).toBe(
      "Merit-first would rank them #1; this balance ranks them #2.",
    );
  });

  test("rejects an unknown preset with the valid names", async () => {
    seedApplicants();

    const res = await request(buildApp()).get(
      "/api/tutor-applications?courseId=1&preset=strongest",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'Unknown preset "strongest". Valid presets: merit, balanced, fairness.',
    );
  });

  test("leaves a tutor's own applications untouched, even with a bogus preset", async () => {
    tables.tutor_subject_preference = [
      {
        id: "a1",
        course_id: 1,
        tutor_id: "t1",
        tutor_mark: 90,
        Availability: true,
        Tutor_name: "Ada",
        status: "pending",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/tutor-applications?tutorId=t1&preset=nonsense",
    );

    // Self-views never order anyone, so the preset is simply ignored.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([tables.tutor_subject_preference[0]]);
  });
});
