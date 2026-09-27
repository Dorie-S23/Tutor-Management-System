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

const coursesRouter = require("./courses");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/courses", coursesRouter);
  return app;
}

function validCourse(overrides = {}) {
  return {
    course_code: "COMS2000",
    course_name: "Data Structures",
    department: "Computer Science",
    min_mark: 60,
    course_level: "honours",
    hours_per_week: 4,
    tutors_needed: 2,
    has_tutorial: true,
    day_of_tut: "Monday",
    tutor_start_time: "09:00",
    tutor_end_time: "10:00",
    venues: "MSL004",
    has_lab: false,
    ...overrides,
  };
}

beforeEach(() => {
  tables = {
    courses: [],
    tutor_subject_preference: [],
    course_volunteers: [],
    notifications: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/courses", () => {
  test("lists every course", async () => {
    tables.courses = [
      { id: 1, course_code: "COMS2000" },
      { id: 2, course_code: "COMS1000" },
    ];

    const res = await request(buildApp()).get("/api/courses");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("POST /api/courses", () => {
  test("rejects a payload missing course_code, course_name or department", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ course_code: "" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("course_code is required");
    expect(tables.courses).toHaveLength(0);
  });

  test("requires at least one of Tutorials or Labs", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ has_tutorial: false, has_lab: false }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Select at least one of Tutorials or Labs");
  });

  test("rejects an invalid tutorial start time", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ tutor_start_time: "25:00" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Tutorial start time must be a valid time (HH:MM)",
    );
  });

  test("rejects a tutorial that starts after it ends", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(
        validCourse({ tutor_start_time: "11:00", tutor_end_time: "10:00" }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Tutorial start time must be before its end time",
    );
  });

  test("rejects a course's own Tutorial and Lab overlapping each other", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(
        validCourse({
          has_lab: true,
          day_of_lab: "Monday",
          lab_start_time: "09:30",
          lab_end_time: "10:30",
          lab_venues: "MSL004",
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/own Tutorial and Lab overlap/);
  });

  test.each([
    ["not an integer", 60.5],
    ["negative", -1],
    ["over 100", 101],
  ])("rejects a min_mark that is %s", async (_label, min_mark) => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ min_mark }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/min_mark/);
  });

  test.each([
    ["missing", undefined],
    ["blank", ""],
    ["not a recognised level", "second_year"],
  ])("rejects a course_level that is %s", async (_label, course_level) => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ course_level }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/course_level/);
    expect(tables.courses).toHaveLength(0);
  });

  test("stores course_level as its numeric rank", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ course_level: "phd" }));

    expect(res.status).toBe(201);
    expect(res.body.course_level).toBe(6);
  });

  test("rejects a duplicate course code with a 409, not a second row", async () => {
    mockSupabase = fakeSupabase(tables, { courses: [["course_code"]] });
    tables.courses = [{ id: 1, course_code: "COMS2000" }];

    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Course code "COMS2000" already exists');
    expect(tables.courses).toHaveLength(1);
  });

  test("blocks a venue clash with another course's tutorial at an overlapping time", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        Day_of_tut: "Monday",
        tutor_start_time: "09:30",
        tutor_end_time: "10:30",
        venues: "MSL004",
      },
    ];

    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse());

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/venue clash/);
    expect(tables.courses).toHaveLength(1);
  });

  test("does not flag a clash against a different venue or a non-overlapping time", async () => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS1000",
        Day_of_tut: "Monday",
        tutor_start_time: "09:30",
        tutor_end_time: "10:30",
        venues: "MSL005", // different room
      },
    ];

    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse());

    expect(res.status).toBe(201);
  });

  test("creates a course with valid input", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      course_code: "COMS2000",
      min_mark: 60,
      course_level: 4,
      hours_per_week: 4,
      tutors_needed: 2,
    });
    expect(tables.courses).toHaveLength(1);
  });

  test("budget is optional and defaults to null", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse());

    expect(res.status).toBe(201);
    expect(res.body.budget).toBeNull();
  });

  test("accepts a budget and stores it as a number", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ budget: "15000" }));

    expect(res.status).toBe(201);
    expect(res.body.budget).toBe(15000);
  });

  test("rejects a negative budget", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ budget: -1 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("budget must be a non-negative number");
    expect(tables.courses).toHaveLength(0);
  });
});

describe("PUT /api/courses/:id", () => {
  beforeEach(() => {
    tables.courses = [
      {
        id: 1,
        course_code: "COMS2000",
        course_name: "Data Structures",
        department: "Computer Science",
        min_mark: 60,
        hours_per_week: 4,
        tutors_needed: 2,
        Day_of_tut: "Monday",
        // Realistic Postgres `time` round-trip shape (with seconds) — the
        // client's submitted payload only ever has "HH:MM", so seeding the
        // "before" row this way is what actually exercises the
        // notifySessionChange format-mismatch bug below.
        tutor_start_time: "09:00:00",
        tutor_end_time: "10:00:00",
        venues: "MSL004",
      },
    ];
  });

  test("rejects a non-numeric id", async () => {
    const res = await request(buildApp())
      .put("/api/courses/not-a-number")
      .send(validCourse());

    expect(res.status).toBe(400);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    // The venue-clash check runs before the existence check and isn't
    // scoped to "courses other than this edit" when the id itself doesn't
    // match anything, so a different venue avoids a spurious 409 here and
    // isolates the 404 path.
    const res = await request(buildApp())
      .put("/api/courses/999")
      .send(validCourse({ venues: "MSL099" }));

    expect(res.status).toBe(404);
  });

  test("doesn't flag a course clashing against its own pre-edit slot", async () => {
    const res = await request(buildApp())
      .put("/api/courses/1")
      .send(validCourse({ venues: "MSL004" }));

    expect(res.status).toBe(200);
  });

  test("edits an existing course", async () => {
    const res = await request(buildApp())
      .put("/api/courses/1")
      .send(validCourse({ course_name: "Data Structures II" }));

    expect(res.status).toBe(200);
    expect(res.body.course_name).toBe("Data Structures II");
  });

  // The notification fan-out is fire-and-forget (not awaited by the route
  // before responding), so these flush a macrotask after the request
  // resolves to let it land before asserting on the fake table.
  function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe("notifying approved tutors/volunteers on a session change", () => {
    beforeEach(() => {
      tables.tutor_subject_preference = [
        { id: 1, tutor_id: "tutor-approved", course_id: 1, status: "approved" },
        { id: 2, tutor_id: "tutor-pending", course_id: 1, status: "pending" },
        {
          id: 3,
          tutor_id: "tutor-other-course",
          course_id: 2,
          status: "approved",
        },
      ];
      tables.course_volunteers = [
        {
          id: 1,
          user_id: "vol-approved",
          course_id: 1,
          status: "approved",
        },
        { id: 2, user_id: "vol-rejected", course_id: 1, status: "rejected" },
      ];
    });

    test("notifies only approved tutors/volunteers on this course when the tutorial time changes", async () => {
      const res = await request(buildApp())
        .put("/api/courses/1")
        .send(
          validCourse({ tutor_start_time: "11:00", tutor_end_time: "12:00" }),
        );
      expect(res.status).toBe(200);
      await flush();

      const recipients = tables.notifications.map((n) => n.user_id).sort();
      expect(recipients).toEqual(["tutor-approved", "vol-approved"]);
      expect(tables.notifications[0]).toMatchObject({
        type: "session_change",
        related_entity: "course",
        related_id: "1",
        read: false,
      });
      expect(tables.notifications[0].message).toContain("COMS2000");
    });

    test("does not notify anyone when the edit doesn't touch day/time/venue", async () => {
      const res = await request(buildApp())
        .put("/api/courses/1")
        .send(validCourse({ course_name: "Data Structures II" }));
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });

    test("does not false-positive on the submitted time's missing seconds (client sends HH:MM, DB round-trips HH:MM:SS)", async () => {
      const res = await request(buildApp())
        .put("/api/courses/1")
        .send(validCourse({ min_mark: 75 }));
      expect(res.status).toBe(200);
      await flush();

      expect(tables.notifications).toHaveLength(0);
    });

    test("notifies when a lab is added to a course that previously had none", async () => {
      const res = await request(buildApp())
        .put("/api/courses/1")
        .send(
          validCourse({
            has_lab: true,
            day_of_lab: "Wednesday",
            lab_start_time: "14:00",
            lab_end_time: "15:00",
            lab_venues: "MSL010",
          }),
        );
      expect(res.status).toBe(200);
      await flush();

      const recipients = tables.notifications.map((n) => n.user_id).sort();
      expect(recipients).toEqual(["tutor-approved", "vol-approved"]);
    });
  });
});

describe("DELETE /api/courses/:id", () => {
  test("rejects a non-numeric id", async () => {
    const res = await request(buildApp()).delete("/api/courses/abc");

    expect(res.status).toBe(400);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    const res = await request(buildApp()).delete("/api/courses/999");

    expect(res.status).toBe(404);
  });

  test("deletes an existing course", async () => {
    tables.courses = [{ id: 1, course_code: "COMS2000" }];

    const res = await request(buildApp()).delete("/api/courses/1");

    expect(res.status).toBe(204);
    expect(tables.courses).toHaveLength(0);
  });
});

describe("PATCH /api/courses/:id/tutors-assigned", () => {
  test("rejects a delta that isn't 1 or -1", async () => {
    tables.courses = [{ id: 1, no_of_tutors_assigned: 0, tutors_needed: 2 }];

    const res = await request(buildApp())
      .patch("/api/courses/1/tutors-assigned")
      .send({ delta: 2 });

    expect(res.status).toBe(400);
  });

  test("returns 404 for a course that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/courses/999/tutors-assigned")
      .send({ delta: 1 });

    expect(res.status).toBe(404);
  });

  test("increments the assigned-tutor count", async () => {
    tables.courses = [{ id: 1, no_of_tutors_assigned: 0, tutors_needed: 2 }];

    const res = await request(buildApp())
      .patch("/api/courses/1/tutors-assigned")
      .send({ delta: 1 });

    expect(res.status).toBe(200);
    expect(res.body.no_of_tutors_assigned).toBe(1);
  });

  test("blocks incrementing past tutors_needed", async () => {
    tables.courses = [{ id: 1, no_of_tutors_assigned: 2, tutors_needed: 2 }];

    const res = await request(buildApp())
      .patch("/api/courses/1/tutors-assigned")
      .send({ delta: 1 });

    expect(res.status).toBe(409);
    expect(tables.courses[0].no_of_tutors_assigned).toBe(2);
  });

  test("blocks decrementing below zero", async () => {
    tables.courses = [{ id: 1, no_of_tutors_assigned: 0, tutors_needed: 2 }];

    const res = await request(buildApp())
      .patch("/api/courses/1/tutors-assigned")
      .send({ delta: -1 });

    expect(res.status).toBe(409);
  });
});

describe("diagonals on the course form", () => {
  test("stores diagonal_count when diagonals are ticked", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ has_diagonals: true, diagonal_count: 3 }));

    expect(res.status).toBe(201);
    expect(tables.courses[0].diagonal_count).toBe(3);
  });

  test("ignores the count when diagonals are unticked", async () => {
    const res = await request(buildApp())
      .post("/api/courses")
      .send(validCourse({ has_diagonals: false, diagonal_count: 3 }));

    expect(res.status).toBe(201);
    expect(tables.courses[0].diagonal_count).toBeNull();
  });

  test.each([1, 27, 2.5, ""])(
    "rejects a diagonal count of %p",
    async (diagonal_count) => {
      const res = await request(buildApp())
        .post("/api/courses")
        .send(validCourse({ has_diagonals: true, diagonal_count }));

      expect(res.status).toBe(400);
      expect(tables.courses).toHaveLength(0);
    },
  );

  test("shrinking the count unassigns anyone in a removed diagonal", async () => {
    tables.courses = [
      { id: 1, ...validCourse(), course_level: 4, diagonal_count: 3 },
    ];
    tables.tutor_subject_preference = [
      { id: 1, course_id: 1, diagonal: "A" },
      { id: 2, course_id: 1, diagonal: "C" },
      { id: 3, course_id: 2, diagonal: "C" },
    ];
    tables.course_volunteers = [{ id: 10, course_id: 1, diagonal: "C" }];

    const res = await request(buildApp())
      .put("/api/courses/1")
      .send(validCourse({ has_diagonals: true, diagonal_count: 2 }));

    expect(res.status).toBe(200);
    expect(tables.tutor_subject_preference.map((r) => r.diagonal)).toEqual([
      "A",
      null,
      "C", // a different course's placement is left alone
    ]);
    expect(tables.course_volunteers[0].diagonal).toBeNull();
  });

  test("turning diagonals off clears every placement on the course", async () => {
    tables.courses = [
      { id: 1, ...validCourse(), course_level: 4, diagonal_count: 2 },
    ];
    tables.tutor_subject_preference = [{ id: 1, course_id: 1, diagonal: "A" }];

    const res = await request(buildApp())
      .put("/api/courses/1")
      .send(validCourse({ has_diagonals: false }));

    expect(res.status).toBe(200);
    expect(tables.courses[0].diagonal_count).toBeNull();
    expect(tables.tutor_subject_preference[0].diagonal).toBeNull();
  });
});
