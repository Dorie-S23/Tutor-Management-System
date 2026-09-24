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

const hourEntriesRouter = require("./hourEntries");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/hour-entries", hourEntriesRouter);
  return app;
}

beforeEach(() => {
  tables = { hour_entries: [], tutors: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("POST /api/hour-entries", () => {
  test("stores an optional courseId alongside the entry", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-09-01",
      hours: 2,
      courseId: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBe(5);
  });

  test("defaults courseId to null when not given", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-09-01",
      hours: 2,
    });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBeNull();
  });
});

describe("GET /api/hour-entries/report", () => {
  beforeEach(() => {
    tables.tutors = [
      { id: "t1", name: "Alice", hourly_rate: 150 },
      { id: "t2", name: "Bob", hourly_rate: 200 },
    ];
  });

  test("groups Tutoring hours by tutor and course, computing cost from the hourly rate", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t1",
        course_id: 1,
        hours: 3,
        date: "2026-09-02",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      tutorId: "t1",
      tutorName: "Alice",
      hourlyRate: 150,
      courseCode: "COMS2000",
      hours: 5,
      cost: 750,
    });
  });

  test("keeps different tutors on the same course as separate rows", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t2",
        course_id: 1,
        hours: 4,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
  });

  test("excludes non-Tutoring task types", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Marking",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
  });

  test("filters by date range when from/to are given", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-08-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
      {
        user_id: "t1",
        course_id: 1,
        hours: 3,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get(
      "/api/hour-entries/report?from=2026-09-01&to=2026-09-30",
    );

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].hours).toBe(3);
  });

  test("reports unlinked hours (no course_id) separately instead of dropping them", async () => {
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: null,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: null,
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.unlinkedHours).toBe(2);
    expect(res.body.unlinkedEntryCount).toBe(1);
  });

  test("leaves cost null when the tutor has no hourly_rate set", async () => {
    tables.tutors = [{ id: "t1", name: "Alice" }];
    tables.hour_entries = [
      {
        user_id: "t1",
        course_id: 1,
        hours: 2,
        date: "2026-09-01",
        task_type: "Tutoring",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          budget: 5000,
        },
      },
    ];

    const res = await request(buildApp()).get("/api/hour-entries/report");

    expect(res.status).toBe(200);
    expect(res.body.rows[0].hourlyRate).toBeNull();
    expect(res.body.rows[0].cost).toBeNull();
  });
});
