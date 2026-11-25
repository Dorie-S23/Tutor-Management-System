const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const courseDiagonalsRouter = require("./courseDiagonals");
const { splitEvenly, diagonalLabels } = courseDiagonalsRouter;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/courses/:courseId/diagonals", courseDiagonalsRouter);
  return app;
}

// fakeSupabase doesn't do real joins, so the joined tutors/users objects are
// seeded directly on each row.
function tutorApp(id, name, overrides = {}) {
  return {
    id,
    tutor_id: `t-${id}`,
    course_id: 1,
    status: "approved",
    diagonal: null,
    tutors: { name, email: `${name.toLowerCase()}@wits.ac.za` },
    ...overrides,
  };
}

function volunteer(id, name, overrides = {}) {
  return {
    id,
    user_id: `u-${id}`,
    course_id: 1,
    status: "approved",
    diagonal: null,
    users: { name, email: `${name.toLowerCase()}@students.wits.ac.za` },
    ...overrides,
  };
}

beforeEach(() => {
  tables = {
    courses: [{ id: 1, course_code: "COMS1018", diagonal_count: 2 }],
    tutor_subject_preference: [],
    course_volunteers: [],
  };
  mockSupabase = fakeSupabase(tables);
});

describe("diagonal helpers", () => {
  test("labels run A, B, C… for the given count", () => {
    expect(diagonalLabels(3)).toEqual(["A", "B", "C"]);
    expect(diagonalLabels(null)).toEqual([]);
  });

  test("splitEvenly gives the first diagonals the leftover people", () => {
    const members = [1, 2, 3, 4, 5].map((id) => ({ id }));
    expect(splitEvenly(members, ["A", "B"])).toEqual({
      A: [1, 2, 3],
      B: [4, 5],
    });
  });
});

describe("GET /api/courses/:courseId/diagonals", () => {
  test("groups approved tutors and volunteers by diagonal", async () => {
    tables.tutor_subject_preference = [
      tutorApp(1, "Ann", { diagonal: "A" }),
      tutorApp(2, "Ben", { diagonal: "B" }),
      tutorApp(3, "Cal"),
      tutorApp(4, "Dee", { status: "pending", diagonal: "A" }),
    ];
    tables.course_volunteers = [volunteer(10, "Sam", { diagonal: "A" })];

    const res = await request(buildApp()).get("/api/courses/1/diagonals");

    expect(res.status).toBe(200);
    expect(res.body.diagonal_count).toBe(2);
    expect(res.body.diagonals.map((d) => d.label)).toEqual(["A", "B"]);
    expect(res.body.diagonals[0].tutors.map((t) => t.name)).toEqual(["Ann"]);
    expect(res.body.diagonals[0].volunteers.map((v) => v.name)).toEqual([
      "Sam",
    ]);
    expect(res.body.diagonals[1].tutors.map((t) => t.name)).toEqual(["Ben"]);
    // pending applicants never show up; unplaced approved ones are unassigned
    expect(res.body.unassigned.tutors.map((t) => t.name)).toEqual(["Cal"]);
  });

  test("treats a label past the current count as unassigned", async () => {
    tables.tutor_subject_preference = [tutorApp(1, "Ann", { diagonal: "C" })];

    const res = await request(buildApp()).get("/api/courses/1/diagonals");

    expect(res.body.unassigned.tutors.map((t) => t.name)).toEqual(["Ann"]);
  });

  test("404s for an unknown course", async () => {
    const res = await request(buildApp()).get("/api/courses/99/diagonals");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/courses/:courseId/diagonals/split", () => {
  test("spreads approved tutors and volunteers evenly by name", async () => {
    tables.tutor_subject_preference = [
      tutorApp(1, "Dee"),
      tutorApp(2, "Ann"),
      tutorApp(3, "Cal"),
      tutorApp(4, "Ben", { status: "rejected" }),
    ];
    tables.course_volunteers = [
      volunteer(10, "Sam"),
      volunteer(11, "Kim"),
      volunteer(12, "Lee"),
      volunteer(13, "Max"),
    ];

    const res = await request(buildApp())
      .post("/api/courses/1/diagonals/split")
      .send({});

    expect(res.status).toBe(200);
    const tutorDiagonal = Object.fromEntries(
      tables.tutor_subject_preference.map((r) => [r.tutors.name, r.diagonal]),
    );
    expect(tutorDiagonal).toEqual({ Ann: "A", Cal: "A", Dee: "B", Ben: null });

    const volunteerDiagonal = Object.fromEntries(
      tables.course_volunteers.map((r) => [r.users.name, r.diagonal]),
    );
    expect(volunteerDiagonal).toEqual({
      Kim: "A",
      Lee: "A",
      Max: "B",
      Sam: "B",
    });
  });

  test("can re-split just one group", async () => {
    tables.tutor_subject_preference = [tutorApp(1, "Ann", { diagonal: "B" })];
    tables.course_volunteers = [volunteer(10, "Sam")];

    const res = await request(buildApp())
      .post("/api/courses/1/diagonals/split")
      .send({ kinds: ["volunteer"] });

    expect(res.status).toBe(200);
    expect(tables.tutor_subject_preference[0].diagonal).toBe("B");
    expect(tables.course_volunteers[0].diagonal).toBe("A");
  });

  test("409s when the course isn't split into diagonals", async () => {
    tables.courses[0].diagonal_count = null;

    const res = await request(buildApp())
      .post("/api/courses/1/diagonals/split")
      .send({});

    expect(res.status).toBe(409);
  });

  test("rejects an unknown kind", async () => {
    const res = await request(buildApp())
      .post("/api/courses/1/diagonals/split")
      .send({ kinds: ["educator"] });

    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/courses/:courseId/diagonals/members", () => {
  test("moves an approved tutor into a diagonal", async () => {
    tables.tutor_subject_preference = [tutorApp(1, "Ann")];

    const res = await request(buildApp())
      .patch("/api/courses/1/diagonals/members")
      .send({ kind: "tutor", id: 1, diagonal: "B" });

    expect(res.status).toBe(200);
    expect(tables.tutor_subject_preference[0].diagonal).toBe("B");
  });

  test("null takes a volunteer out of their diagonal", async () => {
    tables.course_volunteers = [volunteer(10, "Sam", { diagonal: "A" })];

    const res = await request(buildApp())
      .patch("/api/courses/1/diagonals/members")
      .send({ kind: "volunteer", id: 10, diagonal: null });

    expect(res.status).toBe(200);
    expect(tables.course_volunteers[0].diagonal).toBeNull();
  });

  test("rejects a diagonal past the course's count", async () => {
    tables.tutor_subject_preference = [tutorApp(1, "Ann")];

    const res = await request(buildApp())
      .patch("/api/courses/1/diagonals/members")
      .send({ kind: "tutor", id: 1, diagonal: "C" });

    expect(res.status).toBe(400);
    expect(tables.tutor_subject_preference[0].diagonal).toBeNull();
  });

  test("refuses to place someone who isn't approved", async () => {
    tables.tutor_subject_preference = [
      tutorApp(1, "Ann", { status: "pending" }),
    ];

    const res = await request(buildApp())
      .patch("/api/courses/1/diagonals/members")
      .send({ kind: "tutor", id: 1, diagonal: "A" });

    expect(res.status).toBe(409);
  });

  test("404s for a row on a different course", async () => {
    tables.tutor_subject_preference = [tutorApp(1, "Ann", { course_id: 2 })];

    const res = await request(buildApp())
      .patch("/api/courses/1/diagonals/members")
      .send({ kind: "tutor", id: 1, diagonal: "A" });

    expect(res.status).toBe(404);
  });
});
