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

const courseVolunteersRouter = require("./courseVolunteers");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/course-volunteers", courseVolunteersRouter);
  return app;
}

beforeEach(() => {
  tables = { courses: [], course_volunteers: [] };
  mockSupabase = fakeSupabase(tables, {
    course_volunteers: [["user_id", "course_id"]],
  });
});

describe("POST /api/course-volunteers", () => {
  beforeEach(() => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        course_name: "Intro to Programming",
        min_mark: 60,
      },
    ];
  });

  test("a student meeting the mark requirement is recorded as a pending volunteer", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 1, mark: 75 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      user_id: "student-1",
      course_id: 1,
      mark: 75,
      status: "pending",
    });
    expect(tables.course_volunteers).toHaveLength(1);
  });

  test("a mark exactly at the course's minimum is accepted", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 1, mark: 60 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
  });

  test("a mark below the course's minimum is rejected and nothing is recorded", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 1, mark: 59 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "You need at least 60 for COMS1000 to volunteer — you entered 59.",
    );
    expect(tables.course_volunteers).toHaveLength(0);
  });

  test("rejects a request missing userId or courseId", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ courseId: 1, mark: 75 });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers).toHaveLength(0);
  });

  test.each([
    ["not a number", "abc"],
    ["negative", -1],
    ["over 100", 101],
    ["not an integer", 75.5],
  ])("rejects a mark that is %s", async (_label, mark) => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 1, mark });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers).toHaveLength(0);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 999, mark: 75 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Course not found");
  });

  test("a student who has already volunteered for the course gets a 409, not a second row", async () => {
    tables.course_volunteers = [
      {
        id: 1,
        user_id: "student-1",
        course_id: 1,
        mark: 80,
        status: "pending",
      },
    ];

    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ userId: "student-1", courseId: 1, mark: 90 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You've already volunteered for COMS1000.");
    expect(tables.course_volunteers).toHaveLength(1);
  });
});

describe("PATCH /api/course-volunteers/:id", () => {
  // req.params.id from the URL is always a string, so the seeded row's id
  // has to be a string too — fakeSupabase does a strict === match and
  // doesn't coerce types the way Postgrest does for a real integer column.
  beforeEach(() => {
    tables.course_volunteers = [
      {
        id: "1",
        user_id: "student-1",
        course_id: 1,
        mark: 75,
        status: "pending",
      },
    ];
  });

  test("rejects a status that isn't pending, approved or rejected", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "maybe" });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers[0].status).toBe("pending");
  });

  test("an organiser approves a pending volunteer", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.course_volunteers[0].status).toBe("approved");
  });

  test("an organiser rejects a pending volunteer", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(tables.course_volunteers[0].status).toBe("rejected");
  });

  test("a rejection can carry a reason, returned to the caller and stored on the row", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "rejected", reason: "Another applicant is stronger" });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("Another applicant is stronger");
    expect(tables.course_volunteers[0].reason).toBe(
      "Another applicant is stronger",
    );
  });

  test("a rejection with no reason stores null rather than undefined", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(tables.course_volunteers[0].reason).toBeNull();
  });

  test("approving clears any earlier rejection reason rather than leaving it stale", async () => {
    tables.course_volunteers[0].status = "rejected";
    tables.course_volunteers[0].reason = "Mark too low this term";

    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.reason).toBeNull();
    expect(tables.course_volunteers[0].reason).toBeNull();
  });

  test("an organiser can reset a decided volunteer back to pending", async () => {
    tables.course_volunteers[0].status = "approved";

    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "pending" });

    expect(res.status).toBe(200);
    expect(tables.course_volunteers[0].status).toBe("pending");
  });

  test("returns 404 for a volunteer row that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/999")
      .send({ status: "approved" });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/course-volunteers — organiser posting an overflow session", () => {
  beforeEach(() => {
    tables.courses = [{ id: 1, course_code: "COMS1000", min_mark: 60 }];
  });

  test("creates an open, unclaimed session row", async () => {
    const res = await request(buildApp()).post("/api/course-volunteers").send({
      courseId: 1,
      sessionDate: "2026-09-25",
      startTime: "14:00",
      endTime: "16:00",
      venue: "FNB1",
      reason: "Regular tutor is away that week",
      organiserId: "organiser-1",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      course_id: 1,
      session_date: "2026-09-25",
      start_time: "14:00",
      end_time: "16:00",
      venue: "FNB1",
      reason: "Regular tutor is away that week",
      created_by: "organiser-1",
      status: "open",
    });
    expect(res.body.user_id).toBeUndefined();
  });

  test("rejects a session missing required fields", async () => {
    const res = await request(buildApp())
      .post("/api/course-volunteers")
      .send({ courseId: 1, sessionDate: "2026-09-25" });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers).toHaveLength(0);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/course-volunteers").send({
      courseId: 999,
      sessionDate: "2026-09-25",
      startTime: "14:00",
      endTime: "16:00",
    });

    expect(res.status).toBe(404);
  });

  test("posting two open sessions for the same course doesn't collide as duplicate volunteers", async () => {
    const app = buildApp();
    const first = await request(app).post("/api/course-volunteers").send({
      courseId: 1,
      sessionDate: "2026-09-25",
      startTime: "14:00",
      endTime: "16:00",
    });
    const second = await request(app).post("/api/course-volunteers").send({
      courseId: 1,
      sessionDate: "2026-10-02",
      startTime: "14:00",
      endTime: "16:00",
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(tables.course_volunteers).toHaveLength(2);
  });
});

describe("PATCH /api/course-volunteers/:id/claim", () => {
  beforeEach(() => {
    tables.course_volunteers = [
      {
        id: "s1",
        course_id: 1,
        session_date: "2026-09-25",
        start_time: "14:00",
        end_time: "16:00",
        status: "open",
        user_id: null,
      },
    ];
  });

  test("a student claiming an open session attaches their id and moves it to pending", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/s1/claim")
      .send({ userId: "student-1" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.user_id).toBe("student-1");
    expect(tables.course_volunteers[0].status).toBe("pending");
    expect(tables.course_volunteers[0].user_id).toBe("student-1");
  });

  test("rejects a claim with no userId", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/s1/claim")
      .send({});

    expect(res.status).toBe(400);
    expect(tables.course_volunteers[0].status).toBe("open");
  });

  test("a session that's already been claimed can't be claimed again", async () => {
    tables.course_volunteers[0].status = "pending";
    tables.course_volunteers[0].user_id = "student-1";

    const res = await request(buildApp())
      .patch("/api/course-volunteers/s1/claim")
      .send({ userId: "student-2" });

    expect(res.status).toBe(409);
    expect(tables.course_volunteers[0].user_id).toBe("student-1");
  });

  test("claiming a session for a course the student already has an application in gets a clean 409, not a raw DB error", async () => {
    tables.course_volunteers.push({
      id: "a1",
      course_id: 1,
      user_id: "student-1",
      mark: 75,
      status: "pending",
    });

    const res = await request(buildApp())
      .patch("/api/course-volunteers/s1/claim")
      .send({ userId: "student-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already have an application/i);
    expect(tables.course_volunteers[0].status).toBe("open");
  });

  test("returns a clear error for a session id that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/nonexistent/claim")
      .send({ userId: "student-1" });

    expect(res.status).toBe(409);
  });
});

describe("GET /api/course-volunteers?status=open", () => {
  test("returns only open sessions, across every course, with no userId or courseId needed", async () => {
    tables.course_volunteers = [
      { id: "s1", course_id: 1, status: "open", user_id: null },
      { id: "s2", course_id: 2, status: "open", user_id: null },
      { id: "s3", course_id: 1, status: "pending", user_id: "student-1" },
    ];

    const res = await request(buildApp()).get(
      "/api/course-volunteers?status=open",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.id).sort()).toEqual(["s1", "s2"]);
  });
});
