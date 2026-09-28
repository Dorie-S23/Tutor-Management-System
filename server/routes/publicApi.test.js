const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const publicApiRouter = require("./publicApi");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", publicApiRouter);
  return app;
}

// Seed rows are complete internal course rows — including fields the public
// API must never expose (id, budget, min_mark, hours_per_week) — so the
// exact-equality assertions below would actually catch a leak rather than
// pass against an already-thin fixture.
function courseRow(overrides = {}) {
  return {
    id: 1,
    course_code: "COMS2000",
    course_name: "Data Structures",
    department: "Computer Science",
    min_mark: 60,
    course_level: 4,
    hours_per_week: 4,
    tutors_needed: 3,
    no_of_tutors_assigned: 1,
    budget: 15000,
    Day_of_tut: "Monday",
    tutor_start_time: "09:00:00",
    tutor_end_time: "10:00:00",
    venues: "MSL004",
    Day_of_lab: null,
    lab_start_time: null,
    lab_end_time: null,
    lab_venues: null,
    ...overrides,
  };
}

beforeEach(() => {
  tables = { courses: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/v1", () => {
  test("describes the API and its resources", async () => {
    const res = await request(buildApp()).get("/api/v1");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe("v1");
    expect(res.body.resources.courses).toBe("/api/v1/courses");
    expect(res.body.documentation).toMatch(/public-api/);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, s-maxage=300",
    );
  });
});

describe("GET /api/v1/courses", () => {
  test("returns a data envelope with only the public fields", async () => {
    tables.courses = [courseRow()];

    const res = await request(buildApp()).get("/api/v1/courses");

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ count: 1 });
    expect(res.body.data).toEqual([
      {
        course_code: "COMS2000",
        course_name: "Data Structures",
        department: "Computer Science",
        session_types: ["tutorial"],
        openings: 2,
      },
    ]);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, s-maxage=300",
    );
  });

  test.each([
    ["tutorial only", { Day_of_tut: "Monday", Day_of_lab: null }, ["tutorial"]],
    ["lab only", { Day_of_tut: null, Day_of_lab: "Friday" }, ["lab"]],
    [
      "both",
      { Day_of_tut: "Monday", Day_of_lab: "Friday" },
      ["tutorial", "lab"],
    ],
  ])(
    "reports session_types for a %s course",
    async (_label, overrides, expected) => {
      tables.courses = [courseRow(overrides)];

      const res = await request(buildApp()).get("/api/v1/courses");

      expect(res.body.data[0].session_types).toEqual(expected);
    },
  );

  test("treats a missing assigned count as zero", async () => {
    tables.courses = [courseRow({ no_of_tutors_assigned: null })];

    const res = await request(buildApp()).get("/api/v1/courses");

    expect(res.body.data[0].openings).toBe(3);
  });

  test("clamps openings at zero when the course is over-assigned", async () => {
    tables.courses = [
      courseRow({ tutors_needed: 2, no_of_tutors_assigned: 5 }),
    ];

    const res = await request(buildApp()).get("/api/v1/courses");

    expect(res.body.data[0].openings).toBe(0);
  });

  test("lists courses ordered by course code", async () => {
    tables.courses = [
      courseRow({ id: 1, course_code: "MATH2001", course_name: "Algebra" }),
      courseRow({ id: 2, course_code: "COMS1000", course_name: "Programming" }),
    ];

    const res = await request(buildApp()).get("/api/v1/courses");

    expect(res.body.data.map((c) => c.course_code)).toEqual([
      "COMS1000",
      "MATH2001",
    ]);
  });

  test("filters by department, ignoring case", async () => {
    tables.courses = [
      courseRow({ id: 1, course_code: "COMS2000" }),
      courseRow({
        id: 2,
        course_code: "PHYS1000",
        department: "Physics",
      }),
    ];

    const res = await request(buildApp()).get(
      "/api/v1/courses?department=computer%20science",
    );

    expect(res.status).toBe(200);
    expect(res.body.meta.count).toBe(1);
    expect(res.body.data[0].course_code).toBe("COMS2000");
  });

  test("returns an empty list when nothing matches a filter", async () => {
    tables.courses = [courseRow()];

    const res = await request(buildApp()).get("/api/v1/courses?department=Law");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.count).toBe(0);
  });

  test("filters by session_type", async () => {
    tables.courses = [
      courseRow({ id: 1, course_code: "BOTH1000", Day_of_lab: "Friday" }),
      courseRow({ id: 2, course_code: "TUT1000" }),
      courseRow({
        id: 3,
        course_code: "LAB1000",
        Day_of_tut: null,
        Day_of_lab: "Thursday",
      }),
    ];

    const res = await request(buildApp()).get(
      "/api/v1/courses?session_type=lab",
    );

    expect(res.body.data.map((c) => c.course_code)).toEqual([
      "BOTH1000",
      "LAB1000",
    ]);
  });

  test("rejects an unknown session_type", async () => {
    const res = await request(buildApp()).get(
      "/api/v1/courses?session_type=lecture",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'session_type must be either "tutorial" or "lab"',
    );
  });
});

describe("GET /api/v1/courses/:code", () => {
  test("returns one course by its code, with only the public fields", async () => {
    tables.courses = [courseRow()];

    const res = await request(buildApp()).get("/api/v1/courses/COMS2000");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      course_code: "COMS2000",
      course_name: "Data Structures",
      department: "Computer Science",
      session_types: ["tutorial"],
      openings: 2,
    });
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=300, s-maxage=300",
    );
  });

  test("matches a lower-case code", async () => {
    tables.courses = [courseRow()];

    const res = await request(buildApp()).get("/api/v1/courses/coms2000");

    expect(res.status).toBe(200);
    expect(res.body.data.course_code).toBe("COMS2000");
  });

  // The live catalogue has real lower-cased codes (e.g. "coms1033"), so the
  // match has to survive stored casing, not just lower-cased input.
  test("finds a course whose stored code is lower-case", async () => {
    tables.courses = [courseRow({ course_code: "coms1033" })];

    const res = await request(buildApp()).get("/api/v1/courses/COMS1033");

    expect(res.status).toBe(200);
    expect(res.body.data.course_code).toBe("coms1033");
  });

  // The DB's unique constraint is case-sensitive, so both spellings could
  // exist; the exact-case row is the deterministic winner.
  test("prefers an exact-case match when codes differ only by case", async () => {
    tables.courses = [
      courseRow({ id: 1, course_code: "coms3033", course_name: "testing" }),
      courseRow({
        id: 2,
        course_code: "COMS3033",
        course_name: "Testing (duplicate)",
      }),
    ];

    const res = await request(buildApp()).get("/api/v1/courses/COMS3033");

    expect(res.status).toBe(200);
    expect(res.body.data.course_name).toBe("Testing (duplicate)");
  });

  test("returns 404 for a code that doesn't exist", async () => {
    const res = await request(buildApp()).get("/api/v1/courses/NOPE9999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Course not found");
  });
});

describe("read-only enforcement", () => {
  test.each(["post", "put", "patch", "delete"])(
    "%s on the courses collection is rejected with a 405 and an Allow header",
    async (method) => {
      const res = await request(buildApp())[method]("/api/v1/courses");

      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
      expect(res.body.error).toMatch(/read-only/);
    },
  );

  test("a write method on a single course is rejected too", async () => {
    const res = await request(buildApp()).delete("/api/v1/courses/COMS2000");

    expect(res.status).toBe(405);
  });
});
