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
    organiser_requests: [],
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

describe("GET /api/tutors — organiser scoping", () => {
  // org1 is approved for course 5 and still waiting on course 7; the two
  // tutors between them cover an in-scope assignment, an out-of-scope one,
  // and a pending one that must never count.
  function seedScope() {
    tables.users.push(
      {
        id: "org1",
        name: "Org One",
        email: "org1@wits.ac.za",
        role: "organiser",
      },
      {
        id: "org2",
        name: "Org Two",
        email: "org2@wits.ac.za",
        role: "organiser",
      },
      {
        id: "super1",
        name: "Super",
        email: "super@wits.ac.za",
        role: "super_organiser",
      },
      { id: "t-in", name: "Ada In", email: "ada@wits.ac.za", role: "tutor" },
      { id: "t-out", name: "Bob Out", email: "bob@wits.ac.za", role: "tutor" },
    );
    tables.organiser_requests = [
      { id: 1, user_id: "org1", course_id: 5, status: "approved" },
      { id: 2, user_id: "org1", course_id: 7, status: "pending" },
      { id: 3, user_id: "org2", course_id: 9, status: "pending" },
    ];
    tables.tutors = [
      { id: "t-in", name: "Ada In", academic_level: "honours" },
      { id: "t-out", name: "Bob Out", academic_level: "phd" },
    ];
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1016A",
        course_name: "Intro to CS",
        hours_per_week: 3,
      },
      {
        id: 7,
        course_code: "COMS2000",
        course_name: "Data Structures",
        hours_per_week: 6,
      },
    ];
    // fakeSupabase doesn't join — the embedded course rides on the row.
    tables.tutor_subject_preference = [
      {
        tutor_id: "t-in",
        course_id: 5,
        status: "approved",
        courses: {
          course_code: "COMS1016A",
          course_name: "Intro to CS",
          hours_per_week: 3,
        },
      },
      { tutor_id: "t-in", course_id: 7, status: "pending" },
      {
        tutor_id: "t-out",
        course_id: 7,
        status: "approved",
        courses: {
          course_code: "COMS2000",
          course_name: "Data Structures",
          hours_per_week: 6,
        },
      },
    ];
  }

  test("without an organiserId the list stays unscoped", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors");

    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.name)).toEqual(["Ada In", "Bob Out"]);
  });

  test("a course-scoped organiser only sees tutors approved for their courses", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors?organiserId=org1");

    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.id)).toEqual(["t-in"]);
  });

  test("the super-organiser sees every tutor", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors?organiserId=super1");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test("an organiser with no approved courses yet gets an empty list", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors?organiserId=org2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("a caller id that isn't an organiser is rejected", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors?organiserId=t-in");

    expect(res.status).toBe(403);
  });

  test("the workload keeps only in-scope tutors and their in-scope hours", async () => {
    seedScope();

    const res = await request(buildApp()).get(
      "/api/tutors/workload?organiserId=org1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("t-in");
    // Only the approved course-5 assignment counts — the pending course-7
    // row and Bob's out-of-scope course never reach the totals.
    expect(res.body[0].assignedHours).toBe(3);
    expect(res.body[0].courses).toEqual([
      {
        course_code: "COMS1016A",
        course_name: "Intro to CS",
        hours_per_week: 3,
      },
    ]);
  });

  test("the workload without an organiserId stays unscoped", async () => {
    seedScope();

    const res = await request(buildApp()).get("/api/tutors/workload");

    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.id)).toEqual(["t-in", "t-out"]);
    expect(res.body.map((t) => t.assignedHours)).toEqual([3, 6]);
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

describe("/api/tutors/:id/busy-times", () => {
  const busyTime = (fields) => ({
    tutor_id: TUTOR_ID,
    title: "COMS2011A",
    day_of_week: 1,
    start_time: "09:00",
    end_time: "10:00",
    first_date: "2026-01-05",
    end_date: "2026-06-01",
    venue: "FNB1",
    exceptions: [],
    ...fields,
  });

  test("GET lists only this user's classes", async () => {
    tables.tutor_busy_times = [
      busyTime({ id: 2, title: "Second" }),
      busyTime({ id: 1, title: "First" }),
      busyTime({ id: 3, tutor_id: "someone-else" }),
    ];

    const res = await request(buildApp()).get(
      `/api/tutors/${TUTOR_ID}/busy-times`,
    );

    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.title)).toEqual(["First", "Second"]);
  });

  test("POST adds every class for this user", async () => {
    tables.tutor_busy_times = [busyTime({ id: 1 })];

    const res = await request(buildApp())
      .post(`/api/tutors/${TUTOR_ID}/busy-times`)
      .send({
        classes: [
          {
            title: "New class",
            dayOfWeek: 3,
            startTime: "11:00",
            endTime: "12:00",
            firstDate: "2026-01-07",
            endDate: "2026-05-27",
            venue: "",
          },
          {
            title: "Another",
            dayOfWeek: 4,
            startTime: "08:00",
            endTime: "09:00",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      tutor_id: TUTOR_ID,
      title: "New class",
      day_of_week: 3,
      start_time: "11:00",
      end_time: "12:00",
      first_date: "2026-01-07",
      end_date: "2026-05-27",
      venue: null,
    });
    // exceptions is left to the column default, so adding works even
    // before that column exists.
    expect(res.body[0]).not.toHaveProperty("exceptions");
    // The existing class is kept — adding never replaces.
    expect(tables.tutor_busy_times).toHaveLength(3);
  });

  test("POST rejects an empty list or a class without a valid day and times", async () => {
    const app = buildApp();
    const url = `/api/tutors/${TUTOR_ID}/busy-times`;

    expect((await request(app).post(url).send({ classes: [] })).status).toBe(
      400,
    );
    expect(
      (
        await request(app)
          .post(url)
          .send({
            classes: [{ dayOfWeek: 7, startTime: "09:00", endTime: "10:00" }],
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(url)
          .send({ classes: [{ dayOfWeek: 2 }] })
      ).status,
    ).toBe(400);
  });

  test("PATCH updates only the fields sent, including per-day exceptions", async () => {
    tables.tutor_busy_times = [busyTime({ id: 1 })];
    const exceptions = [{ date: "2026-01-12", type: "cancelled" }];

    const res = await request(buildApp())
      .patch(`/api/tutors/${TUTOR_ID}/busy-times/1`)
      .send({ venue: "WSS", exceptions });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "COMS2011A",
      venue: "WSS",
      exceptions,
    });
    expect(tables.tutor_busy_times[0].exceptions).toEqual(exceptions);
  });

  test("PATCH 404s for another user's class and 400s with nothing to change", async () => {
    tables.tutor_busy_times = [busyTime({ id: 1, tutor_id: "someone-else" })];
    const app = buildApp();

    const notMine = await request(app)
      .patch(`/api/tutors/${TUTOR_ID}/busy-times/1`)
      .send({ venue: "WSS" });
    expect(notMine.status).toBe(404);
    expect(tables.tutor_busy_times[0].venue).toBe("FNB1");

    const empty = await request(app)
      .patch(`/api/tutors/${TUTOR_ID}/busy-times/1`)
      .send({});
    expect(empty.status).toBe(400);

    const badExceptions = await request(app)
      .patch(`/api/tutors/${TUTOR_ID}/busy-times/1`)
      .send({ exceptions: "nope" });
    expect(badExceptions.status).toBe(400);
  });

  test("DELETE one class leaves the rest, and never touches another user's", async () => {
    tables.tutor_busy_times = [
      busyTime({ id: 1 }),
      busyTime({ id: 2 }),
      busyTime({ id: 3, tutor_id: "someone-else" }),
    ];
    const app = buildApp();

    expect(
      (await request(app).delete(`/api/tutors/${TUTOR_ID}/busy-times/1`))
        .status,
    ).toBe(204);
    expect(
      (await request(app).delete(`/api/tutors/${TUTOR_ID}/busy-times/3`))
        .status,
    ).toBe(204);

    expect(tables.tutor_busy_times.map((b) => b.id)).toEqual([2, 3]);
  });

  test("DELETE without an id clears all of this user's classes only", async () => {
    tables.tutor_busy_times = [
      busyTime({ id: 1 }),
      busyTime({ id: 2, tutor_id: "someone-else" }),
    ];

    const res = await request(buildApp()).delete(
      `/api/tutors/${TUTOR_ID}/busy-times`,
    );

    expect(res.status).toBe(204);
    expect(tables.tutor_busy_times.map((b) => b.id)).toEqual([2]);
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
