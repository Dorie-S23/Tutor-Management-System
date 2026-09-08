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
  tables = { courses: [], tutor_subject_preference: [] };
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
      { id: "a1", course_id: 1, tutor_mark: 70, Availability: true, Tutor_name: "Alice", status: "pending" },
      { id: "a2", course_id: 1, tutor_mark: 40, Availability: true, Tutor_name: "Bob", status: "pending" }, // below min_mark
      { id: "a3", course_id: 2, tutor_mark: 80, Availability: true, Tutor_name: "Cara", status: "pending" },
      { id: "a4", course_id: 2, tutor_mark: 90, Availability: true, Tutor_name: "Dan", status: "pending" },
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
      { id: "a1", course_id: 1, tutor_mark: 90, Availability: false, Tutor_name: "Alice", status: "pending" },
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
