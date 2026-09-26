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
  tables = { courses: [], course_volunteers: [], notifications: [] };
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

  test("an organiser approves a pending volunteer, recording the reason", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "approved", approvalReason: "Strong mark, good fit" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(tables.course_volunteers[0].status).toBe("approved");
    expect(tables.course_volunteers[0].approval_reason).toBe(
      "Strong mark, good fit",
    );
  });

  test("approving without a reason is rejected with a 400", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "approved" });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers[0].status).toBe("pending");
  });

  test("an organiser rejects a pending volunteer, recording the reason", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "rejected", rejectionReason: "Mark too low" });

    expect(res.status).toBe(200);
    expect(tables.course_volunteers[0].status).toBe("rejected");
    expect(tables.course_volunteers[0].rejection_reason).toBe("Mark too low");
  });

  test("rejecting without a reason is rejected with a 400", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "rejected" });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers[0].status).toBe("pending");
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
      .send({ status: "approved", approvalReason: "Strong mark" });

    expect(res.status).toBe(404);
  });

  test("a locked volunteer's status can't be changed", async () => {
    tables.course_volunteers[0].status = "approved";
    tables.course_volunteers[0].locked = true;

    const res = await request(buildApp())
      .patch("/api/course-volunteers/1")
      .send({ status: "pending" });

    expect(res.status).toBe(409);
    expect(tables.course_volunteers[0].status).toBe("approved");
  });

  // The notification fan-out is fire-and-forget (not awaited before the
  // route responds), so these flush a macrotask after the request resolves
  // to let it land before asserting on the fake table.
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe("notifying the student of the outcome", () => {
    beforeEach(() => {
      // fakeSupabase doesn't do real joins — seed the embedded shape the
      // route's .select("*, courses(...)") expects back directly.
      tables.course_volunteers[0].courses = { course_code: "COMS2000" };
    });

    test("approving notifies the student", async () => {
      const res = await request(buildApp())
        .patch("/api/course-volunteers/1")
        .send({ status: "approved", approvalReason: "Strong mark" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(1);
      expect(tables.notifications[0]).toMatchObject({
        user_id: "student-1",
        type: "volunteer_status",
        related_entity: "volunteer_application",
        read: false,
      });
      expect(tables.notifications[0].message).toContain("COMS2000");
    });

    test("rejecting a pending volunteer notifies them it was rejected, not removed", async () => {
      const res = await request(buildApp())
        .patch("/api/course-volunteers/1")
        .send({ status: "rejected", rejectionReason: "Mark too low" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toMatch(/was rejected/);
    });

    test("rejecting a previously-approved volunteer tells them they were removed", async () => {
      tables.course_volunteers[0].status = "approved";

      const res = await request(buildApp())
        .patch("/api/course-volunteers/1")
        .send({ status: "rejected", rejectionReason: "Course cancelled" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications[0].message).toMatch(/removed from/);
    });

    test("resetting to pending doesn't notify anyone", async () => {
      tables.course_volunteers[0].status = "approved";

      const res = await request(buildApp())
        .patch("/api/course-volunteers/1")
        .send({ status: "pending" });
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });
  });
});

describe("PATCH /api/course-volunteers/:id/lock", () => {
  beforeEach(() => {
    tables.course_volunteers = [
      {
        id: "1",
        user_id: "student-1",
        course_id: 1,
        mark: 75,
        status: "approved",
        locked: false,
      },
    ];
  });

  test("locks an approved volunteer", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1/lock")
      .send({ locked: true });

    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(true);
    expect(tables.course_volunteers[0].locked).toBe(true);
  });

  test("rejects anything other than locked: true", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/1/lock")
      .send({ locked: false });

    expect(res.status).toBe(400);
    expect(tables.course_volunteers[0].locked).toBe(false);
  });

  test("refuses to lock a volunteer that isn't approved", async () => {
    tables.course_volunteers[0].status = "pending";

    const res = await request(buildApp())
      .patch("/api/course-volunteers/1/lock")
      .send({ locked: true });

    expect(res.status).toBe(409);
    expect(tables.course_volunteers[0].locked).toBe(false);
  });

  test("refuses to lock a volunteer that's already locked", async () => {
    tables.course_volunteers[0].locked = true;

    const res = await request(buildApp())
      .patch("/api/course-volunteers/1/lock")
      .send({ locked: true });

    expect(res.status).toBe(409);
  });

  test("404s for a volunteer that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/course-volunteers/999/lock")
      .send({ locked: true });

    expect(res.status).toBe(404);
  });
});
