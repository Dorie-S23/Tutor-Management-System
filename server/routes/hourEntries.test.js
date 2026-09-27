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
  tables = { hour_entries: [], tutors: [], academic_level_rates: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("POST /api/hour-entries", () => {
  beforeEach(() => {
    tables.courses = [{ id: 5, course_code: "COMS1018" }];
  });

  test("links the entry to the course and labels it with the course code", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-09-01",
      hours: 2,
      courseId: 5,
      subject: "something else",
    });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBe(5);
    expect(res.body.subject).toBe("COMS1018");
  });

  test("rejects an entry with no courseId", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-09-01",
      hours: 2,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("courseId is required");
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects an entry for a course that doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "t1",
      date: "2026-09-01",
      hours: 2,
      courseId: 999,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unknown course");
    expect(tables.hour_entries).toHaveLength(0);
  });
});

describe("PUT /api/hour-entries/:id", () => {
  beforeEach(() => {
    tables.courses = [
      { id: 5, course_code: "COMS1018" },
      { id: 6, course_code: "MATH1036" },
    ];
    tables.hour_entries = [
      {
        id: "e1",
        user_id: "t1",
        date: "2026-09-01",
        hours: 2,
        course_id: 5,
        subject: "COMS1018",
      },
    ];
  });

  test("moves the entry to another course and relabels it", async () => {
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: "2026-09-01",
      hours: 2,
      courseId: 6,
    });

    expect(res.status).toBe(200);
    expect(res.body.course_id).toBe(6);
    expect(res.body.subject).toBe("MATH1036");
  });

  test("won't unlink an entry from its course", async () => {
    const res = await request(buildApp()).put("/api/hour-entries/e1").send({
      date: "2026-09-01",
      hours: 2,
      courseId: null,
    });

    expect(res.status).toBe(400);
    expect(tables.hour_entries[0].course_id).toBe(5);
  });
});

describe("GET /api/hour-entries/report", () => {
  beforeEach(() => {
    tables.tutors = [
      { id: "t1", name: "Alice", academic_level: "honours" },
      { id: "t2", name: "Bob", academic_level: "masters" },
    ];
    tables.academic_level_rates = [
      { academic_level: "honours", hourly_rate: 150 },
      { academic_level: "masters", hourly_rate: 200 },
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

  test("leaves cost null when the tutor has no academic_level set", async () => {
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

describe("tutor session logging rules", () => {
  const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  function toDateStr(date) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
  }

  // The next occurrence of a weekday strictly after today, so the
  // "upcoming session" rule is exercised against the real clock without
  // freezing time.
  function weekdayDate(dayName) {
    const target = DAY_NAMES.indexOf(dayName);
    const date = new Date();
    for (let i = 1; i <= 7; i += 1) {
      date.setDate(date.getDate() + 1);
      if (date.getDay() === target) break;
    }
    return toDateStr(date);
  }

  // The most recent occurrence of a weekday strictly before today.
  function pastWeekdayDate(dayName) {
    const target = DAY_NAMES.indexOf(dayName);
    const date = new Date();
    for (let i = 1; i <= 7; i += 1) {
      date.setDate(date.getDate() - 1);
      if (date.getDay() === target) break;
    }
    return toDateStr(date);
  }

  beforeEach(() => {
    tables.tutors = [{ id: "t1", name: "Oupa" }];
    tables.tutor_subject_preference = [
      { tutor_id: "t1", course_id: 5, status: "approved" },
    ];
    tables.courses = [
      {
        id: 5,
        course_code: "COMS1018A",
        Day_of_tut: "Monday",
        tutor_start_time: "10:00:00",
        tutor_end_time: "12:00:00",
        Day_of_lab: "Wednesday",
        lab_start_time: "14:00:00",
        lab_end_time: "15:00:00",
      },
      {
        id: 6,
        course_code: "MATH1036",
        Day_of_tut: "Friday",
        tutor_start_time: "09:00:00",
        tutor_end_time: "10:00:00",
      },
    ];
  });

  test("accepts a tutor's entry for the course's upcoming tutorial slot", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: weekdayDate("Monday"),
        hours: 2,
        startTime: "10:00",
        endTime: "12:00",
        taskType: "Tutoring",
        courseId: 5,
      });

    expect(res.status).toBe(201);
    expect(res.body.course_id).toBe(5);
    expect(tables.hour_entries).toHaveLength(1);
  });

  test("accepts the lab slot as well", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: weekdayDate("Wednesday"),
        hours: 1,
        startTime: "14:00",
        endTime: "15:00",
        courseId: 5,
      });

    expect(res.status).toBe(201);
    expect(tables.hour_entries).toHaveLength(1);
  });

  test("rejects times that don't match any scheduled slot", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: weekdayDate("Monday"),
        hours: 6,
        startTime: "09:00",
        endTime: "16:00",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduled tutorial or lab/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a date that isn't the slot's weekday", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: weekdayDate("Tuesday"),
        hours: 2,
        startTime: "10:00",
        endTime: "12:00",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a session that has already passed", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: pastWeekdayDate("Monday"),
        hours: 2,
        startTime: "10:00",
        endTime: "12:00",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/upcoming/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("rejects a course the tutor isn't approved for", async () => {
    const res = await request(buildApp())
      .post("/api/hour-entries")
      .send({
        userId: "t1",
        date: weekdayDate("Friday"),
        hours: 1,
        startTime: "09:00",
        endTime: "10:00",
        courseId: 6,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/approved/);
    expect(tables.hour_entries).toHaveLength(0);
  });

  test("still accepts free-form entries from non-tutors (volunteers)", async () => {
    const res = await request(buildApp()).post("/api/hour-entries").send({
      userId: "vol1",
      date: "2026-09-01",
      hours: 1.5,
      startTime: "08:00",
      endTime: "09:30",
      taskType: "Peer support",
      courseId: 5,
    });

    expect(res.status).toBe(201);
    expect(tables.hour_entries).toHaveLength(1);
  });

  test("lets a tutor edit notes without touching the session", async () => {
    const legacyDate = pastWeekdayDate("Monday");
    tables.hour_entries = [
      {
        id: "e9",
        user_id: "t1",
        date: legacyDate,
        hours: 2,
        course_id: 5,
        start_time: "08:00:00",
        end_time: "10:00:00",
        task_type: "Marking",
        notes: "",
      },
    ];

    const res = await request(buildApp()).put("/api/hour-entries/e9").send({
      date: legacyDate,
      hours: 2,
      startTime: "08:00",
      endTime: "10:00",
      taskType: "Marking",
      notes: "fixed a typo",
      courseId: 5,
    });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("fixed a typo");
  });

  test("rejects moving an entry's time away from a scheduled slot", async () => {
    tables.hour_entries = [
      {
        id: "e10",
        user_id: "t1",
        date: weekdayDate("Monday"),
        hours: 2,
        course_id: 5,
        start_time: "10:00:00",
        end_time: "12:00:00",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e10")
      .send({
        date: weekdayDate("Monday"),
        hours: 3,
        startTime: "09:00",
        endTime: "12:00",
        courseId: 5,
      });

    expect(res.status).toBe(400);
    expect(tables.hour_entries[0].start_time).toBe("10:00:00");
  });

  test("allows re-pointing an entry onto a real slot, even in a past week", async () => {
    tables.hour_entries = [
      {
        id: "e11",
        user_id: "t1",
        date: weekdayDate("Monday"),
        hours: 2,
        course_id: 5,
        start_time: "10:00:00",
        end_time: "12:00:00",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e11")
      .send({
        date: pastWeekdayDate("Monday"),
        hours: 2,
        startTime: "10:00",
        endTime: "12:00",
        courseId: 5,
      });

    expect(res.status).toBe(200);
    expect(tables.hour_entries[0].date).toBe(pastWeekdayDate("Monday"));
  });

  test("rejects moving a tutor's entry to a course they aren't approved for", async () => {
    tables.hour_entries = [
      {
        id: "e12",
        user_id: "t1",
        date: weekdayDate("Monday"),
        hours: 2,
        course_id: 5,
        start_time: "10:00:00",
        end_time: "12:00:00",
      },
    ];

    const res = await request(buildApp())
      .put("/api/hour-entries/e12")
      .send({
        date: weekdayDate("Monday"),
        hours: 2,
        startTime: "10:00",
        endTime: "12:00",
        courseId: 6,
      });

    expect(res.status).toBe(403);
    expect(tables.hour_entries[0].course_id).toBe(5);
  });
});
