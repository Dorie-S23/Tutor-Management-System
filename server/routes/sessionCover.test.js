const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const sessionExcusalsRouter = require("./sessionExcusals");
const notificationsRouter = require("./notifications");
const { fillUncoveredForCourse, reassignCoversOf } = require("./sessionCover");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/session-excusals", sessionExcusalsRouter);
  app.use("/api/notifications", notificationsRouter);
  return app;
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

// Dates relative to today (UTC, same as the routes), so reminder windows
// and "not in the past" checks behave the same whatever day this runs.
function daysFromToday(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

const SESSION_DATE = daysFromToday(10);
const SESSION_DAY = weekdayOf(SESSION_DATE);

// fakeSupabase does no joins, so the embedded courses/users/tutors objects
// the real selects would return are seeded directly on each row.
const COURSE = {
  course_code: "COMS4033",
  course_name: "Testing",
  Day_of_lab: SESSION_DAY,
  lab_start_time: "12:30:00",
  lab_end_time: "13:15:00",
  lab_venues: "MSL004",
};

function volunteer(userId, name, overrides = {}) {
  return {
    id: `cv-${userId}`,
    user_id: userId,
    course_id: 16,
    status: "approved",
    diagonal: null,
    created_at: "2026-01-01T00:00:00Z",
    users: { name },
    courses: COURSE,
    ...overrides,
  };
}

function excusal(overrides = {}) {
  return {
    id: "1",
    tutor_id: "tutor-1",
    course_id: 16,
    session_date: SESSION_DATE,
    session_type: "lab",
    cover_user_id: null,
    cover_declined_by: [],
    courses: COURSE,
    tutors: { name: "arti" },
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function notificationsFor(userId, type) {
  return tables.notifications.filter(
    (n) => n.user_id === userId && (!type || n.type === type),
  );
}

beforeEach(() => {
  tables = {
    courses: [{ id: 16, ...COURSE }],
    tutor_subject_preference: [
      {
        id: "tsp-1",
        tutor_id: "tutor-1",
        course_id: 16,
        status: "approved",
        diagonal: null,
      },
    ],
    course_volunteers: [],
    session_excusals: [],
    notifications: [],
    users: [
      { id: "vol-1", name: "Ann" },
      { id: "vol-2", name: "Ben" },
      { id: "vol-3", name: "Cat" },
    ],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("automatic cover when a tutor excuses themselves", () => {
  // Picks a cover for an already-seeded excusal — unlike a fresh insert,
  // its embedded course is there, so session times can be clash-checked.
  function pickForSeeded() {
    tables.session_excusals.push(excusal({ id: "new" }));
    return request(buildApp()).post("/api/session-excusals/new/find-cover");
  }
  const picked = () =>
    tables.session_excusals.find((e) => e.id === "new").cover_user_id;

  function excuse() {
    return request(buildApp()).post("/api/session-excusals").send({
      tutorId: "tutor-1",
      courseId: 16,
      sessionType: "lab",
      sessionDate: SESSION_DATE,
    });
  }

  test("assigns an approved volunteer and notifies them and the tutor", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Sam"),
      volunteer("vol-2", "Kim", { status: "pending" }),
    ];

    const res = await excuse();
    await flush();

    expect(res.status).toBe(201);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
    expect(notificationsFor("vol-1", "cover_assigned")).toHaveLength(1);
    expect(notificationsFor("tutor-1", "cover_found")[0].message).toMatch(
      /^Sam will cover your/,
    );
  });

  test("leaves it uncovered and tells the tutor when nobody is approved", async () => {
    const res = await excuse();
    await flush();

    expect(res.status).toBe(201);
    expect(tables.session_excusals[0].cover_user_id).toBeNull();
    expect(notificationsFor("tutor-1", "cover_unavailable")).toHaveLength(1);
  });

  test("skips a volunteer whose own session on another course clashes", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann", { created_at: "2025-01-01T00:00:00Z" }),
      volunteer("vol-2", "Ben"),
      // Ann is also approved on a course meeting at the same time that day
      {
        ...volunteer("vol-1", "Ann"),
        id: "cv-other",
        course_id: 99,
        courses: {
          course_code: "COMS1000",
          Day_of_tut: SESSION_DAY,
          tutor_start_time: "13:00:00",
          tutor_end_time: "14:00:00",
        },
      },
    ];

    await pickForSeeded();

    expect(picked()).toBe("vol-2");
  });

  test("prefers a volunteer in the excused tutor's diagonal", async () => {
    tables.tutor_subject_preference[0].diagonal = "B";
    tables.course_volunteers = [
      volunteer("vol-1", "Ann", { diagonal: "A" }),
      volunteer("vol-2", "Ben", { diagonal: "B" }),
    ];

    await pickForSeeded();

    expect(picked()).toBe("vol-2");
  });

  test("spreads covers to whoever has the fewest upcoming ones", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann"),
      volunteer("vol-2", "Ben"),
    ];
    tables.session_excusals = [
      excusal({
        id: "50",
        tutor_id: "tutor-9",
        session_date: daysFromToday(20),
        cover_user_id: "vol-1",
      }),
    ];

    await pickForSeeded();

    expect(picked()).toBe("vol-2");
  });
});

describe("POST /api/session-excusals/:id/decline-cover", () => {
  test("hands the session to the next volunteer and remembers the decline", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann"),
      volunteer("vol-2", "Ben"),
    ];
    tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];

    const res = await request(buildApp())
      .post("/api/session-excusals/1/decline-cover")
      .send({ userId: "vol-1" });
    await flush();

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-2");
    expect(tables.session_excusals[0].cover_declined_by).toEqual(["vol-1"]);
    expect(notificationsFor("vol-2", "cover_assigned")).toHaveLength(1);
    expect(notificationsFor("tutor-1", "cover_found")[0].message).toMatch(
      /^Ben/,
    );
  });

  test("refuses someone who isn't the cover", async () => {
    tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];

    const res = await request(buildApp())
      .post("/api/session-excusals/1/decline-cover")
      .send({ userId: "vol-2" });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/session-excusals/:id/find-cover", () => {
  test("fills an uncovered session", async () => {
    tables.course_volunteers = [volunteer("vol-1", "Ann")];
    tables.session_excusals = [excusal()];

    const res = await request(buildApp()).post(
      "/api/session-excusals/1/find-cover",
    );

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
  });

  test("tells the volunteer exactly which session they're covering", async () => {
    tables.course_volunteers = [volunteer("vol-1", "Ann")];
    tables.session_excusals = [excusal()];

    await request(buildApp()).post("/api/session-excusals/1/find-cover");
    await flush();

    expect(notificationsFor("vol-1", "cover_assigned")[0].message).toMatch(
      /cover COMS4033 Lab on .*, 12:30–13:15 \(MSL004\) for arti\. We'll remind you the day before\./,
    );
    expect(notificationsFor("tutor-1", "cover_found")[0].message).toMatch(
      /^Ann will cover your COMS4033 Lab/,
    );
  });

  test("replaces the current cover and tells them", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann"),
      volunteer("vol-2", "Ben"),
    ];
    tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];

    await request(buildApp()).post("/api/session-excusals/1/find-cover");
    await flush();

    expect(tables.session_excusals[0].cover_user_id).toBe("vol-2");
    expect(notificationsFor("vol-1", "cover_cancelled")).toHaveLength(1);
  });
});

test("cancelling an excusal tells the volunteer they're no longer needed", async () => {
  tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];

  const res = await request(buildApp()).delete("/api/session-excusals/1");
  await flush();

  expect(res.status).toBe(204);
  expect(notificationsFor("vol-1", "cover_cancelled")[0].message).toMatch(
    /arti can make it after all/,
  );
});

test("GET ?coverUserId=... lists the sessions a volunteer is covering", async () => {
  tables.session_excusals = [
    excusal({ id: "1", cover_user_id: "vol-1" }),
    excusal({ id: "2", cover_user_id: "vol-2" }),
  ];

  const res = await request(buildApp()).get(
    "/api/session-excusals?coverUserId=vol-1",
  );

  expect(res.status).toBe(200);
  expect(res.body.map((e) => e.id)).toEqual(["1"]);
});

describe("cover reminders (sent when the notification bell polls)", () => {
  test("reminds once for a cover tomorrow, and not for one further out", async () => {
    tables.session_excusals = [
      excusal({ id: "1", session_date: daysFromToday(1), cover_user_id: "v" }),
      excusal({ id: "2", session_date: daysFromToday(5), cover_user_id: "v" }),
    ];

    await request(buildApp()).get("/api/notifications?userId=v");
    await request(buildApp()).get("/api/notifications?userId=v");

    const reminders = notificationsFor("v", "cover_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0].related_id).toBe("1");
    expect(reminders[0].message).toMatch(/that's tomorrow/);
    expect(tables.session_excusals[0].cover_reminded_at).toBeTruthy();
    expect(tables.session_excusals[1].cover_reminded_at).toBeUndefined();
  });

  test("a cover assigned the day before doesn't get a second reminder", async () => {
    tables.course_volunteers = [volunteer("vol-1", "Ann")];
    const tomorrow = daysFromToday(1);
    tables.courses[0].Day_of_lab = weekdayOf(tomorrow);
    tables.session_excusals = [
      excusal({
        session_date: tomorrow,
        courses: { ...COURSE, Day_of_lab: weekdayOf(tomorrow) },
      }),
    ];

    await request(buildApp()).post("/api/session-excusals/1/find-cover");
    await request(buildApp()).get("/api/notifications?userId=vol-1");
    await flush();

    expect(notificationsFor("vol-1", "cover_assigned")).toHaveLength(1);
    expect(notificationsFor("vol-1", "cover_reminder")).toHaveLength(0);
  });
});

describe("volunteer-to-volunteer swaps", () => {
  beforeEach(() => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann"),
      volunteer("vol-2", "Ben"),
      volunteer("vol-3", "Cat"),
    ];
    tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];
  });

  const post = (path, body) =>
    request(buildApp()).post(`/api/session-excusals/1/${path}`).send(body);

  test("lists the other eligible volunteers to choose from", async () => {
    // Cat is busy covering something else at that exact time
    tables.session_excusals.push(
      excusal({ id: "9", tutor_id: "tutor-9", cover_user_id: "vol-3" }),
    );

    const res = await request(buildApp()).get(
      "/api/session-excusals/1/swap-candidates?userId=vol-1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ user_id: "vol-2", name: "Ben" }]);
  });

  test("only the current cover can see candidates or ask for a swap", async () => {
    const list = await request(buildApp()).get(
      "/api/session-excusals/1/swap-candidates?userId=vol-2",
    );
    const ask = await post("swap-request", {
      userId: "vol-2",
      toUserId: "vol-3",
    });

    expect(list.status).toBe(403);
    expect(ask.status).toBe(403);
  });

  test("a request leaves the cover in place until it's answered", async () => {
    const res = await post("swap-request", {
      userId: "vol-1",
      toUserId: "vol-2",
    });
    await flush();

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
    expect(tables.session_excusals[0].swap_to_user_id).toBe("vol-2");
    expect(notificationsFor("vol-2", "swap_request")[0].message).toMatch(
      /^Ann can't make COMS4033 Lab .* asked you to take it over/,
    );
  });

  test("refuses to ask someone who isn't eligible", async () => {
    tables.course_volunteers[1].status = "pending";

    const res = await post("swap-request", {
      userId: "vol-1",
      toUserId: "vol-2",
    });

    expect(res.status).toBe(409);
    expect(tables.session_excusals[0].swap_to_user_id).toBeUndefined();
  });

  test("accepting moves the cover and tells the requester and tutor", async () => {
    await post("swap-request", { userId: "vol-1", toUserId: "vol-2" });

    const res = await post("swap-respond", { userId: "vol-2", accept: true });
    await flush();

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-2");
    expect(tables.session_excusals[0].swap_to_user_id).toBeNull();
    expect(notificationsFor("vol-1", "swap_accepted")).toHaveLength(1);
    expect(notificationsFor("tutor-1", "cover_found")[0].message).toMatch(
      /^Ben is now covering .* \(swapped with Ann\)/,
    );
  });

  test("declining keeps the requester as the cover", async () => {
    await post("swap-request", { userId: "vol-1", toUserId: "vol-2" });

    const res = await post("swap-respond", { userId: "vol-2", accept: false });
    await flush();

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
    expect(tables.session_excusals[0].swap_to_user_id).toBeNull();
    expect(notificationsFor("vol-1", "swap_declined")[0].message).toMatch(
      /^Ben can't take over .* you're still covering it/,
    );
  });

  test("only the asked volunteer can answer", async () => {
    await post("swap-request", { userId: "vol-1", toUserId: "vol-2" });

    const res = await post("swap-respond", { userId: "vol-3", accept: true });

    expect(res.status).toBe(403);
    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
  });

  test("the requester can withdraw an unanswered request", async () => {
    await post("swap-request", { userId: "vol-1", toUserId: "vol-2" });

    const res = await post("swap-withdraw", { userId: "vol-1" });
    await flush();

    expect(res.status).toBe(200);
    expect(tables.session_excusals[0].swap_to_user_id).toBeNull();
    expect(notificationsFor("vol-2", "swap_withdrawn")).toHaveLength(1);
  });

  test("GET ?swapToUserId=... lists requests waiting on a volunteer", async () => {
    await post("swap-request", { userId: "vol-1", toUserId: "vol-2" });

    const res = await request(buildApp()).get(
      "/api/session-excusals?swapToUserId=vol-2",
    );

    expect(res.body.map((e) => e.id)).toEqual(["1"]);
  });
});

describe("keeping covers in step with volunteer approvals", () => {
  test("a newly approved volunteer fills uncovered upcoming sessions", async () => {
    tables.course_volunteers = [volunteer("vol-1", "Ann")];
    tables.session_excusals = [
      excusal({ id: "1" }),
      excusal({ id: "2", cover_user_id: "someone-else" }),
    ];

    await fillUncoveredForCourse(16);

    expect(tables.session_excusals[0].cover_user_id).toBe("vol-1");
    expect(tables.session_excusals[1].cover_user_id).toBe("someone-else");
  });

  test("a volunteer taken off the course hands their covers on", async () => {
    tables.course_volunteers = [
      volunteer("vol-1", "Ann", { status: "rejected" }),
      volunteer("vol-2", "Ben"),
    ];
    tables.session_excusals = [excusal({ cover_user_id: "vol-1" })];

    await reassignCoversOf("vol-1", 16);
    await flush();

    expect(tables.session_excusals[0].cover_user_id).toBe("vol-2");
    expect(notificationsFor("vol-1", "cover_cancelled")).toHaveLength(1);
  });
});
