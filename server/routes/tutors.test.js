const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
  auth: { signUp: (...args) => mockSupabase.auth.signUp(...args) },
}));

const tutorsRouter = require("./tutors");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/tutors", tutorsRouter);
  return app;
}

const TUTOR_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_COURSE_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  tables = {
    tutors: [],
    tutor_subject_preference: [],
    tutor_busy_times: [],
    courses: [],
    users: [],
    academic_level_rates: [],
  };
  mockSupabase = fakeSupabase(tables);
  mockSupabase.auth = {
    signUp: jest.fn().mockResolvedValue({
      data: { user: { id: "new-tutor-id" } },
      error: null,
    }),
  };
});

describe("GET /api/tutors/:id", () => {
  test("returns a clean 404 (not a Postgres error) for a non-UUID id", async () => {
    const res = await request(buildApp()).get("/api/tutors/not-a-uuid");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Tutor not found");
  });

  test("returns 404 for a well-formed but unknown UUID", async () => {
    const res = await request(buildApp()).get(`/api/tutors/${TUTOR_ID}`);

    expect(res.status).toBe(404);
  });

  test("returns the tutor for a known id", async () => {
    tables.tutors = [{ id: TUTOR_ID, name: "Alice", weekly_hour_cap: 10 }];

    const res = await request(buildApp()).get(`/api/tutors/${TUTOR_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Alice");
  });
});

describe("PUT /api/tutors/bulk", () => {
  test("requires weekly_hour_cap", async () => {
    const res = await request(buildApp()).put("/api/tutors/bulk").send({});

    expect(res.status).toBe(400);
  });

  test("sets the weekly hour cap for every tutor and reports how many were updated", async () => {
    tables.tutors = [
      { id: "t1", name: "Alice", weekly_hour_cap: 5 },
      { id: "t2", name: "Bob", weekly_hour_cap: 8 },
    ];

    const res = await request(buildApp())
      .put("/api/tutors/bulk")
      .send({ weekly_hour_cap: 12 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2 });
    expect(tables.tutors.every((t) => t.weekly_hour_cap === 12)).toBe(true);
  });

  test("reports zero updated when there are no tutors yet", async () => {
    const res = await request(buildApp())
      .put("/api/tutors/bulk")
      .send({ weekly_hour_cap: 12 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0 });
  });
});

describe("POST /api/tutors/bulk-rates", () => {
  test("requires a rates object", async () => {
    const res = await request(buildApp())
      .post("/api/tutors/bulk-rates")
      .send({});

    expect(res.status).toBe(400);
  });

  test("rejects a negative or non-numeric rate", async () => {
    const res = await request(buildApp())
      .post("/api/tutors/bulk-rates")
      .send({ rates: { honours: -5 } });

    expect(res.status).toBe(400);
    expect(tables.academic_level_rates).toHaveLength(0);
  });

  test("inserts a rate for a level that has none yet", async () => {
    const res = await request(buildApp())
      .post("/api/tutors/bulk-rates")
      .send({ rates: { honours: 120, masters: 180 } });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const byLevel = Object.fromEntries(
      tables.academic_level_rates.map((r) => [r.academic_level, r]),
    );
    expect(byLevel.honours.hourly_rate).toBe(120);
    expect(byLevel.masters.hourly_rate).toBe(180);
  });

  test("updates a level's existing rate in place rather than duplicating it", async () => {
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 100 },
    ];

    const res = await request(buildApp())
      .post("/api/tutors/bulk-rates")
      .send({ rates: { honours: 130 } });

    expect(res.status).toBe(200);
    expect(tables.academic_level_rates).toHaveLength(1);
    expect(tables.academic_level_rates[0].hourly_rate).toBe(130);
  });

  test("a saved rate applies to every tutor at that level, not just the ones that existed when it was set", async () => {
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 100 },
    ];
    await request(buildApp())
      .post("/api/tutors/bulk-rates")
      .send({ rates: { honours: 130 } });

    tables.tutors = [
      { id: "t1", academic_level: "honours" },
      { id: "t2", academic_level: "honours" },
    ];

    const res = await request(buildApp()).get("/api/tutors");

    expect(res.body.every((t) => t.hourly_rate === 130)).toBe(true);
  });
});

describe("GET /api/tutors/rates", () => {
  test("returns the current rate for each level", async () => {
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "phd", hourly_rate: 200 },
    ];

    const res = await request(buildApp()).get("/api/tutors/rates");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ honours: 150, phd: 200 });
  });
});

describe("PUT /api/tutors/:id", () => {
  test("edits an existing tutor's fields", async () => {
    tables.tutors = [
      { id: TUTOR_ID, name: "Alice", academic_level: "honours" },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
    ];

    const res = await request(buildApp())
      .put(`/api/tutors/${TUTOR_ID}`)
      .send({ name: "Alice Smith", academic_level: "honours" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Alice Smith");
  });

  test("derives hourly_rate from the tutor's academic_level rather than trusting the request body", async () => {
    tables.tutors = [
      { id: TUTOR_ID, name: "Alice", academic_level: "honours" },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
    ];

    const res = await request(buildApp())
      .put(`/api/tutors/${TUTOR_ID}`)
      .send({ name: "Alice", academic_level: "honours", hourly_rate: 999 });

    expect(res.status).toBe(200);
    expect(res.body.hourly_rate).toBe(150);
  });
});

describe("DELETE /api/tutors/:id", () => {
  test("removes the tutor", async () => {
    tables.tutors = [{ id: TUTOR_ID, name: "Alice" }];

    const res = await request(buildApp()).delete(`/api/tutors/${TUTOR_ID}`);

    expect(res.status).toBe(204);
    expect(tables.tutors).toHaveLength(0);
  });
});

describe("PUT /api/tutors/:id/busy-times", () => {
  test("requires classes to be an array", async () => {
    const res = await request(buildApp())
      .put(`/api/tutors/${TUTOR_ID}/busy-times`)
      .send({ classes: "not-an-array" });

    expect(res.status).toBe(400);
  });

  test("fully replaces the tutor's previous busy times with the new list", async () => {
    tables.tutor_busy_times = [
      {
        id: 1,
        tutor_id: TUTOR_ID,
        title: "Old class",
        day_of_week: 1,
        start_time: "09:00",
        end_time: "10:00",
      },
      { id: 2, tutor_id: "someone-else", day_of_week: 2 },
    ];

    const res = await request(buildApp())
      .put(`/api/tutors/${TUTOR_ID}/busy-times`)
      .send({
        classes: [
          {
            title: "New class",
            dayOfWeek: 3,
            startTime: "11:00",
            endTime: "12:00",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const remaining = tables.tutor_busy_times.filter(
      (b) => b.tutor_id === TUTOR_ID,
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("New class");
    // Another tutor's busy times are untouched.
    expect(
      tables.tutor_busy_times.some((b) => b.tutor_id === "someone-else"),
    ).toBe(true);
  });

  test("an empty list just clears the tutor's busy times", async () => {
    tables.tutor_busy_times = [{ id: 1, tutor_id: TUTOR_ID, day_of_week: 1 }];

    const res = await request(buildApp())
      .put(`/api/tutors/${TUTOR_ID}/busy-times`)
      .send({ classes: [] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(tables.tutor_busy_times).toHaveLength(0);
  });
});

describe("GET /api/tutors/:id/assignment-check", () => {
  test("requires courseId", async () => {
    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check`,
    );

    expect(res.status).toBe(400);
  });

  test("404s when the tutor doesn't exist", async () => {
    tables.courses = [{ id: OTHER_COURSE_ID, hours_per_week: 3 }];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check?courseId=${OTHER_COURSE_ID}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Tutor not found");
  });

  test("404s when the course doesn't exist", async () => {
    tables.tutors = [{ id: TUTOR_ID, weekly_hour_cap: 10 }];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check?courseId=${OTHER_COURSE_ID}`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Course not found");
  });

  test("flags a busy-time clash and reports projected workload under the cap", async () => {
    tables.tutors = [{ id: TUTOR_ID, weekly_hour_cap: 10 }];
    tables.courses = [
      {
        id: OTHER_COURSE_ID,
        Day_of_tut: "Monday",
        tutor_start_time: "10:00",
        tutor_end_time: "11:00",
        hours_per_week: 3,
      },
    ];
    tables.tutor_busy_times = [
      {
        tutor_id: TUTOR_ID,
        title: "Gym",
        day_of_week: 1, // Monday
        start_time: "10:30",
        end_time: "11:30",
      },
    ];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check?courseId=${OTHER_COURSE_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.clashes.busyTimeClashes).toHaveLength(1);
    expect(res.body.clashes.busyTimeClashes[0].title).toBe("Gym");
    expect(res.body.workload).toEqual({
      weeklyHourCap: 10,
      currentAssignedHours: 0,
      courseHours: 3,
      projectedHours: 3,
      overCap: false,
    });
  });

  test("flags overCap when the projected hours exceed the tutor's weekly cap", async () => {
    tables.tutors = [{ id: TUTOR_ID, weekly_hour_cap: 5 }];
    tables.courses = [
      {
        id: OTHER_COURSE_ID,
        Day_of_tut: "Tuesday",
        tutor_start_time: "09:00",
        tutor_end_time: "10:00",
        hours_per_week: 4,
      },
    ];
    // Another course the tutor is already approved for — fakeSupabase doesn't
    // do real joins, so the embedded "courses" object is seeded directly.
    tables.tutor_subject_preference = [
      {
        tutor_id: TUTOR_ID,
        course_id: "some-other-course",
        status: "approved",
        courses: {
          course_code: "COMS2000",
          Day_of_tut: "Thursday",
          tutor_start_time: "09:00",
          tutor_end_time: "10:00",
          hours_per_week: 3,
        },
      },
    ];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check?courseId=${OTHER_COURSE_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.workload).toEqual({
      weeklyHourCap: 5,
      currentAssignedHours: 3,
      courseHours: 4,
      projectedHours: 7,
      overCap: true,
    });
    // Different days (Tuesday vs Thursday) — no clash, just over the cap.
    expect(res.body.clashes.courseClashes).toHaveLength(0);
  });

  test("flags a clash with a course the tutor already teaches on the same day", async () => {
    tables.tutors = [{ id: TUTOR_ID, weekly_hour_cap: null }];
    tables.courses = [
      {
        id: OTHER_COURSE_ID,
        Day_of_tut: "Wednesday",
        tutor_start_time: "09:00",
        tutor_end_time: "11:00",
        hours_per_week: 2,
      },
    ];
    tables.tutor_subject_preference = [
      {
        tutor_id: TUTOR_ID,
        course_id: "already-teaching",
        status: "approved",
        courses: {
          course_code: "COMS3000",
          Day_of_tut: "Wednesday",
          tutor_start_time: "10:00",
          tutor_end_time: "12:00",
          hours_per_week: 3,
        },
      },
    ];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/assignment-check?courseId=${OTHER_COURSE_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.clashes.courseClashes).toHaveLength(1);
    expect(res.body.clashes.courseClashes[0].course_code).toBe("COMS3000");
    // No cap set — never flagged as over cap.
    expect(res.body.workload.overCap).toBe(false);
  });
});

describe("POST /api/tutors", () => {
  function validPayload(overrides = {}) {
    return {
      name: "Alice Example",
      student_number: "1234567",
      email: "alice@students.wits.ac.za",
      academic_level: "honours",
      weekly_hour_cap: 10,
      ...overrides,
    };
  }

  test("rejects a payload missing required fields, with all the problems listed together", async () => {
    const res = await request(buildApp()).post("/api/tutors").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Name is required/);
    expect(res.body.error).toMatch(/Student number is required/);
    expect(res.body.error).toMatch(/Email is required/);
    expect(res.body.error).toMatch(/Academic level is required/);
  });

  test("rejects a non-Wits email", async () => {
    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload({ email: "alice@gmail.com" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/@wits\.ac\.za or @students\.wits\.ac\.za/);
  });

  test("rejects a duplicate student number without touching auth", async () => {
    tables.tutors = [{ id: "existing", student_number: "1234567" }];

    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload());

    expect(res.status).toBe(409);
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  test("rejects a duplicate email already registered as a user account", async () => {
    tables.users = [{ id: "existing", email: "alice@students.wits.ac.za" }];

    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload());

    expect(res.status).toBe(409);
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  test("creates the auth user, the users row and the tutors row on a valid submission", async () => {
    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload());

    expect(res.status).toBe(201);
    expect(mockSupabase.auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({ email: "alice@students.wits.ac.za" }),
    );
    expect(tables.users).toHaveLength(1);
    expect(tables.users[0]).toMatchObject({
      id: "new-tutor-id",
      role: "tutor",
    });
    expect(tables.tutors).toHaveLength(1);
    expect(tables.tutors[0]).toMatchObject({
      id: "new-tutor-id",
      name: "Alice Example",
      student_number: "1234567",
    });
  });

  test("derives hourly_rate from the honours rate rather than accepting one directly", async () => {
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
    ];

    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload({ hourly_rate: 999 }));

    expect(res.status).toBe(201);
    expect(res.body.hourly_rate).toBe(150);
    expect(tables.tutors[0].hourly_rate).toBeUndefined();
  });

  test("surfaces a clear message when the auth email is already registered", async () => {
    mockSupabase.auth.signUp.mockResolvedValue({
      data: null,
      error: { message: "User already registered" },
    });

    const res = await request(buildApp())
      .post("/api/tutors")
      .send(validPayload());

    expect(res.status).toBe(409);
    expect(tables.tutors).toHaveLength(0);
  });
});
