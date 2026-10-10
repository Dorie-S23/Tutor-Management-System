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

const attendanceVerificationRouter = require("./attendanceVerification");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/attendance-verification", attendanceVerificationRouter);
  return app;
}

// Lets the fire-and-forget notification chains that started before the
// response went out finish before assertions run.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function weekdayOf(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00`).getDay()];
}

// A Tuesday; the course fixture's tutorial sits on its weekday at the
// entry's exact times, so the queue labels it Tutorial.
const SESSION_DATE = "2026-10-06";
const TUT_START = "10:00:00";
const TUT_END = "12:00:00";

function tutorialEntry(overrides = {}) {
  return {
    id: "e1",
    user_id: "vol1",
    course_id: 5,
    date: SESSION_DATE,
    hours: 2,
    start_time: TUT_START,
    end_time: TUT_END,
    task_type: "Peer support",
    subject: "COMS1018",
    notes: "",
    verification_status: "pending",
    ...overrides,
  };
}

function seedCourse() {
  tables.courses = [
    {
      id: 5,
      course_code: "COMS1018",
      course_name: "Discrete Computational Structures",
      Day_of_tut: weekdayOf(SESSION_DATE),
      tutor_start_time: TUT_START,
      tutor_end_time: TUT_END,
      venues: "MSL004,005",
      Day_of_lab: null,
      lab_start_time: null,
      lab_end_time: null,
      lab_venues: null,
    },
  ];
}

function seedLogger() {
  tables.users = [
    {
      id: "vol1",
      name: "Naledi Mokoena",
      email: "n@wits.ac.za",
      role: "volunteer",
    },
  ];
}

beforeEach(() => {
  tables = {
    hour_entries: [],
    users: [],
    courses: [],
    organiser_requests: [],
    notifications: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/attendance-verification", () => {
  beforeEach(() => {
    seedCourse();
    seedLogger();
    tables.hour_entries = [tutorialEntry()];
  });

  test("stitches on the logger, course, Tutorial label and venue", async () => {
    const res = await request(buildApp()).get("/api/attendance-verification");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "e1",
      session_type: "Tutorial",
      venue: "MSL004,005",
      user: { name: "Naledi Mokoena" },
      course: { course_code: "COMS1018" },
    });
  });

  test("filters by status and rejects unknown ones", async () => {
    tables.hour_entries.push(
      tutorialEntry({ id: "e2", verification_status: "verified" }),
    );

    const pending = await request(buildApp()).get(
      "/api/attendance-verification?status=pending",
    );
    expect(pending.status).toBe(200);
    expect(pending.body.map((row) => row.id)).toEqual(["e1"]);

    const bogus = await request(buildApp()).get(
      "/api/attendance-verification?status=lol",
    );
    expect(bogus.status).toBe(400);
  });

  test("orders newest sessions first", async () => {
    tables.hour_entries.push(tutorialEntry({ id: "e0", date: "2026-09-29" }));

    const res = await request(buildApp()).get("/api/attendance-verification");

    expect(res.body.map((row) => row.id)).toEqual(["e1", "e0"]);
  });

  test("scopes a plain organiser to their approved courses", async () => {
    tables.users.push({
      id: "org1",
      name: "Org One",
      email: "o1@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 5,
        status: "approved",
        kind: "signup",
      },
      {
        id: 2,
        user_id: "org1",
        course_id: 9,
        status: "pending",
        kind: "access",
      },
    ];
    // A course-9 entry the scoped organiser must not see.
    seedCourse();
    tables.courses.push({
      id: 9,
      course_code: "COMS2000",
      course_name: "Data Structures",
      Day_of_tut: null,
      tutor_start_time: null,
      tutor_end_time: null,
      venues: null,
      Day_of_lab: null,
      lab_start_time: null,
      lab_end_time: null,
      lab_venues: null,
    });
    tables.hour_entries.push(tutorialEntry({ id: "e9", course_id: 9 }));

    const res = await request(buildApp()).get(
      "/api/attendance-verification?organiserId=org1",
    );

    expect(res.status).toBe(200);
    expect(res.body.map((row) => row.id)).toEqual(["e1"]);
  });

  test("an organiser with no approved courses gets an empty queue", async () => {
    tables.users.push({
      id: "org2",
      name: "Org Two",
      email: "o2@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org2",
        course_id: 5,
        status: "denied",
        kind: "signup",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/attendance-verification?organiserId=org2",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("a grandfathered organiser and the super-organiser see every course", async () => {
    tables.users.push(
      {
        id: "org3",
        name: "Org Three",
        email: "o3@wits.ac.za",
        role: "organiser",
      },
      {
        id: "admin1",
        name: "Admin",
        email: "a@wits.ac.za",
        role: "super_organiser",
      },
    );

    const grandfathered = await request(buildApp()).get(
      "/api/attendance-verification?organiserId=org3",
    );
    const superOrg = await request(buildApp()).get(
      "/api/attendance-verification?organiserId=admin1",
    );

    expect(grandfathered.body).toHaveLength(1);
    expect(superOrg.body).toHaveLength(1);
  });

  test("rejects callers that aren't organisers", async () => {
    tables.users.push({
      id: "tutor1",
      name: "Not An Organiser",
      email: "t@wits.ac.za",
      role: "tutor",
    });

    const res = await request(buildApp()).get(
      "/api/attendance-verification?organiserId=tutor1",
    );

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/attendance-verification/:id", () => {
  beforeEach(() => {
    seedCourse();
    seedLogger();
    tables.hour_entries = [tutorialEntry()];
    tables.users.push({
      id: "org1",
      name: "Org One",
      email: "o1@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 5,
        status: "approved",
        kind: "signup",
      },
    ];
  });

  test("verifies an entry and notifies the owner", async () => {
    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "verified", reviewerId: "org1" });

    expect(res.status).toBe(200);
    expect(res.body.verification_status).toBe("verified");
    expect(res.body.verified_by).toBe("org1");
    expect(res.body.verified_at).toBeTruthy();

    await flush();
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]).toMatchObject({
      user_id: "vol1",
      type: "attendance_verified",
    });
    expect(tables.notifications[0].message).toMatch(/COMS1018/);
    expect(tables.notifications[0].message).toMatch(/verified/i);
  });

  test("flagging requires a note", async () => {
    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "flagged", reviewerId: "org1" });

    expect(res.status).toBe(400);
    expect(tables.hour_entries[0].verification_status).toBe("pending");
  });

  test("flags with a note and tells the owner why", async () => {
    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({
        status: "flagged",
        note: "No one saw you at the lab",
        reviewerId: "org1",
      });

    expect(res.status).toBe(200);
    expect(res.body.verification_status).toBe("flagged");
    expect(res.body.verification_note).toBe("No one saw you at the lab");

    await flush();
    expect(tables.notifications[0]).toMatchObject({
      user_id: "vol1",
      type: "attendance_flagged",
    });
    expect(tables.notifications[0].message).toMatch(
      /No one saw you at the lab/,
    );
  });

  test("re-opening a decided entry clears the earlier call and stays quiet", async () => {
    tables.hour_entries[0].verification_status = "verified";
    tables.hour_entries[0].verified_by = "org1";
    tables.hour_entries[0].verified_at = "2026-10-07T09:00:00.000Z";
    tables.hour_entries[0].verification_note = "fine";

    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "pending", reviewerId: "org1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      verification_status: "pending",
      verified_by: null,
      verified_at: null,
      verification_note: null,
    });

    await flush();
    expect(tables.notifications).toHaveLength(0);
  });

  test("400s on bad payloads: unknown status, missing reviewer", async () => {
    const badStatus = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "maybe", reviewerId: "org1" });
    const noReviewer = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "verified" });

    expect(badStatus.status).toBe(400);
    expect(noReviewer.status).toBe(400);
  });

  test("404s for an unknown entry", async () => {
    const res = await request(buildApp())
      .patch("/api/attendance-verification/nope")
      .send({ status: "verified", reviewerId: "org1" });

    expect(res.status).toBe(404);
  });

  test("refuses a reviewer without access to the entry's course", async () => {
    tables.users.push({
      id: "org9",
      name: "Other Course Org",
      email: "o9@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests.push({
      id: 2,
      user_id: "org9",
      course_id: 9,
      status: "approved",
      kind: "signup",
    });

    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "verified", reviewerId: "org9" });

    expect(res.status).toBe(403);
    expect(tables.hour_entries[0].verification_status).toBe("pending");
  });

  test("refuses a reviewer who isn't an organiser at all", async () => {
    tables.users.push({
      id: "vol2",
      name: "Another Volunteer",
      email: "v2@wits.ac.za",
      role: "volunteer",
    });

    const res = await request(buildApp())
      .patch("/api/attendance-verification/e1")
      .send({ status: "verified", reviewerId: "vol2" });

    expect(res.status).toBe(403);
  });
});
