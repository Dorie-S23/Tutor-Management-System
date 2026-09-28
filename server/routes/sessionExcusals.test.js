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

const sessionExcusalsRouter = require("./sessionExcusals");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/session-excusals", sessionExcusalsRouter);
  return app;
}

// Derived the same way the route itself derives a weekday from a date, so
// these tests aren't hostage to which day of the week "today" happens to be.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const FUTURE_DATE = "2030-06-10";
const FUTURE_DATE_WEEKDAY =
  DAY_NAMES[new Date(`${FUTURE_DATE}T00:00:00Z`).getUTCDay()];

beforeEach(() => {
  tables = {
    courses: [],
    tutor_subject_preference: [],
    session_excusals: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/session-excusals", () => {
  test("requires tutorId or courseId", async () => {
    const res = await request(buildApp()).get("/api/session-excusals");

    expect(res.status).toBe(400);
  });

  test("?tutorId=... returns only that tutor's excusals", async () => {
    tables.session_excusals = [
      { id: 1, tutor_id: "t1", course_id: 10, session_date: "2030-01-01" },
      { id: 2, tutor_id: "t2", course_id: 10, session_date: "2030-01-01" },
    ];

    const res = await request(buildApp()).get(
      "/api/session-excusals?tutorId=t1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].tutor_id).toBe("t1");
  });

  test("?courseId=... returns everyone excused from that course", async () => {
    // req.query.courseId from the URL is always a string, so the seeded
    // course_id has to be a string too — fakeSupabase does a strict ===
    // match and doesn't coerce types the way Postgrest does for a real
    // integer column.
    tables.session_excusals = [
      { id: 1, tutor_id: "t1", course_id: "10", session_date: "2030-01-01" },
      { id: 2, tutor_id: "t2", course_id: "20", session_date: "2030-01-01" },
    ];

    const res = await request(buildApp()).get(
      "/api/session-excusals?courseId=10",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].course_id).toBe("10");
  });
});

describe("POST /api/session-excusals", () => {
  beforeEach(() => {
    tables.courses = [
      { id: 10, course_code: "COMS2000", Day_of_tut: FUTURE_DATE_WEEKDAY },
    ];
    tables.tutor_subject_preference = [
      { tutor_id: "t1", course_id: 10, status: "approved" },
    ];
  });

  test("requires tutorId, courseId and sessionDate", async () => {
    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1" });

    expect(res.status).toBe(400);
  });

  test("rejects a sessionDate in the past", async () => {
    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 10, sessionDate: "2000-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/can't be in the past/);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 999, sessionDate: FUTURE_DATE });

    expect(res.status).toBe(404);
  });

  test("rejects a sessionDate that doesn't fall on the course's tutorial day", async () => {
    // The course only meets on FUTURE_DATE_WEEKDAY, and FUTURE_DATE itself
    // falls on that day, so walk forward a day at a time from FUTURE_DATE
    // until landing on any other weekday.
    let mismatchDate = new Date(`${FUTURE_DATE}T00:00:00Z`);
    while (DAY_NAMES[mismatchDate.getUTCDay()] === FUTURE_DATE_WEEKDAY) {
      mismatchDate.setUTCDate(mismatchDate.getUTCDate() + 1);
    }
    const mismatchDateStr = mismatchDate.toISOString().slice(0, 10);

    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 10, sessionDate: mismatchDateStr });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't meet on that day/);
  });

  test("accepts a sessionDate on the lab day of a lab-only course", async () => {
    tables.courses = [
      {
        id: 10,
        course_code: "COMS4033",
        Day_of_tut: null,
        Day_of_lab: FUTURE_DATE_WEEKDAY,
      },
    ];

    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 10, sessionDate: FUTURE_DATE });

    expect(res.status).toBe(201);
    expect(tables.session_excusals[0].session_type).toBe("lab");
  });

  test("stores the session type the tutor picked", async () => {
    tables.courses = [
      {
        id: 10,
        course_code: "COMS2000",
        Day_of_tut: "Monday",
        Day_of_lab: FUTURE_DATE_WEEKDAY,
      },
    ];

    const res = await request(buildApp()).post("/api/session-excusals").send({
      tutorId: "t1",
      courseId: 10,
      sessionType: "lab",
      sessionDate: FUTURE_DATE,
    });

    expect(res.status).toBe(201);
    expect(tables.session_excusals[0].session_type).toBe("lab");
  });

  test("rejects a date that isn't the picked session's day", async () => {
    const res = await request(buildApp()).post("/api/session-excusals").send({
      tutorId: "t1",
      courseId: 10,
      sessionType: "lab",
      sessionDate: FUTURE_DATE,
    });

    // the seeded course only has a tutorial
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't have a lab/);
  });

  test("rejects an unknown session type", async () => {
    const res = await request(buildApp()).post("/api/session-excusals").send({
      tutorId: "t1",
      courseId: 10,
      sessionType: "lecture",
      sessionDate: FUTURE_DATE,
    });

    expect(res.status).toBe(400);
  });

  test("asks which session when a tutorial and lab share the day", async () => {
    tables.courses = [
      {
        id: 10,
        course_code: "COMS2000",
        Day_of_tut: FUTURE_DATE_WEEKDAY,
        Day_of_lab: FUTURE_DATE_WEEKDAY,
      },
    ];

    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 10, sessionDate: FUTURE_DATE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/both a tutorial and a lab/);
  });

  test("rejects a tutor who isn't approved to tutor that course", async () => {
    const res = await request(buildApp()).post("/api/session-excusals").send({
      tutorId: "t-not-assigned",
      courseId: 10,
      sessionDate: FUTURE_DATE,
    });

    expect(res.status).toBe(403);
  });

  test("records the excusal for an approved tutor on a valid session date", async () => {
    const res = await request(buildApp()).post("/api/session-excusals").send({
      tutorId: "t1",
      courseId: 10,
      sessionDate: FUTURE_DATE,
      reason: "Sick",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tutor_id: "t1",
      course_id: 10,
      session_date: FUTURE_DATE,
      reason: "Sick",
    });
    expect(tables.session_excusals).toHaveLength(1);
  });

  test("a second excusal for the same tutor/course/date gets a 409, not a duplicate row", async () => {
    mockSupabase = fakeSupabase(tables, {
      session_excusals: [["tutor_id", "course_id", "session_date"]],
    });
    tables.session_excusals = [
      {
        id: 1,
        tutor_id: "t1",
        course_id: 10,
        session_date: FUTURE_DATE,
        reason: null,
      },
    ];

    const res = await request(buildApp())
      .post("/api/session-excusals")
      .send({ tutorId: "t1", courseId: 10, sessionDate: FUTURE_DATE });

    expect(res.status).toBe(409);
    expect(tables.session_excusals).toHaveLength(1);
  });
});

describe("DELETE /api/session-excusals/:id", () => {
  test("removes the excusal", async () => {
    // req.params.id is always a string, so the seeded row's id has to
    // match as a string too (see the courseId note above).
    tables.session_excusals = [
      { id: "1", tutor_id: "t1", course_id: 10, session_date: "2030-01-01" },
    ];

    const res = await request(buildApp()).delete("/api/session-excusals/1");

    expect(res.status).toBe(204);
    expect(tables.session_excusals).toHaveLength(0);
  });
});
