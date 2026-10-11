const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../server/testUtils/fakeSupabase");

let tables;
let mockSupabase;

const authRouter = require("./auth");

function buildApp() {
  const app = express();
  app.use(express.json());
  // Matches app.js's real middleware: req.supabase, attached per-request.
  app.use((req, res, next) => {
    req.supabase = mockSupabase;
    next();
  });
  app.use("/api/auth", authRouter);
  return app;
}

beforeEach(() => {
  // Every table any flow under test touches has to be seeded — the fake
  // throws on an unseeded table rather than pretending it's empty.
  tables = {
    users: [],
    students: [],
    tutors: [],
    organisers: [],
    courses: [],
    organiser_requests: [],
  };
  mockSupabase = fakeSupabase(tables);
  mockSupabase.auth = {
    signInWithPassword: jest.fn(),
    signUp: jest.fn(),
  };
});

describe("POST /api/auth/login", () => {
  test("requires email and password", async () => {
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@wits.ac.za" });

    expect(res.status).toBe(400);
  });

  test("logs in successfully and returns the user's role", async () => {
    tables.users = [
      { id: "u1", email: "a@wits.ac.za", name: "Alice", role: "tutor" },
    ];
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", email: "a@wits.ac.za" } },
      error: null,
    });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@wits.ac.za", password: "correct-password" });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "u1", role: "tutor" });
  });

  test("a legacy student role is reported as volunteer", async () => {
    tables.users = [
      { id: "u1", email: "a@wits.ac.za", name: "Alice", role: "student" },
    ];
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: { id: "u1", email: "a@wits.ac.za" } },
      error: null,
    });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@wits.ac.za", password: "correct-password" });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("volunteer");
  });

  test("a wrong password for a normal account gets Supabase's generic error", async () => {
    tables.users = [
      {
        id: "u1",
        email: "a@wits.ac.za",
        name: "Alice",
        role: "tutor",
        auth_provider: "password",
      },
    ];
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@wits.ac.za", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid login credentials");
  });

  test("a Google-only account trying a password gets a specific hint instead of the generic error", async () => {
    tables.users = [
      {
        id: "u1",
        email: "a@wits.ac.za",
        name: "Alice",
        role: "tutor",
        auth_provider: "google",
      },
    ];
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@wits.ac.za", password: "anything" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe(
      "You signed up with Google — please sign in with Google.",
    );
  });

  test("an unregistered email still gets the generic error, not a Google hint", async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "nobody@wits.ac.za", password: "anything" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid login credentials");
  });
});

describe("POST /api/auth/register", () => {
  const BASE = {
    email: "new@wits.ac.za",
    password: "secret-password",
    name: "New User",
  };

  test("an organiser without a course is rejected before anything is created", async () => {
    const res = await request(buildApp())
      .post("/api/auth/register")
      .send({ ...BASE, role: "organiser" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Choose the course you want to be an organiser for",
    );
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  test("an organiser picking a course that doesn't exist is rejected", async () => {
    tables.courses = [
      { id: 7, course_code: "COS132", course_name: "Imperative Programming" },
    ];

    const res = await request(buildApp())
      .post("/api/auth/register")
      .send({ ...BASE, role: "organiser", courseId: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("That course does not exist");
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  // The request row is what the login gate reads: while it's pending the
  // organiser can't sign in, and approving it grants exactly this course.
  test("an organiser registration files a pending request for the chosen course", async () => {
    tables.courses = [
      { id: 7, course_code: "COS132", course_name: "Imperative Programming" },
    ];
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { user: { id: "org1", email: BASE.email } },
      error: null,
    });

    const res = await request(buildApp())
      .post("/api/auth/register")
      .send({ ...BASE, role: "organiser", courseId: 7 });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ id: "org1", role: "organiser" });
    expect(tables.organisers).toHaveLength(1);
    expect(tables.organisers[0].staff_id).toMatch(/^A\d{7}$/);
    expect(tables.organiser_requests).toHaveLength(1);
    expect(tables.organiser_requests[0]).toMatchObject({
      user_id: "org1",
      course_id: 7,
      status: "pending",
    });
  });

  test("a volunteer registration still works without any course", async () => {
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { user: { id: "vol1", email: BASE.email } },
      error: null,
    });

    const res = await request(buildApp())
      .post("/api/auth/register")
      .send({ ...BASE, role: "volunteer", studentNumber: "1234567" });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("volunteer");
    expect(tables.organiser_requests).toHaveLength(0);
  });

  test("a registration with a student number that isn't 5–7 plain digits is rejected", async () => {
    for (const studentNumber of ["123", "12345678", "12345a7"]) {
      const res = await request(buildApp())
        .post("/api/auth/register")
        .send({ ...BASE, role: "volunteer", studentNumber });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Student number must be 5–7 digits");
    }
    expect(mockSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  test("a valid registration stores the student number trimmed of whitespace", async () => {
    mockSupabase.auth.signUp.mockResolvedValue({
      data: { user: { id: "vol1", email: BASE.email } },
      error: null,
    });

    const res = await request(buildApp())
      .post("/api/auth/register")
      .send({ ...BASE, role: "volunteer", studentNumber: " 1234567 " });

    expect(res.status).toBe(201);
    expect(tables.students[0].student_no).toBe("1234567");
  });
});

describe("POST /api/auth/login — the organiser approval gate", () => {
  function seedOrganiser() {
    tables.users = [
      {
        id: "u1",
        email: "org@wits.ac.za",
        name: "Olive",
        role: "organiser",
        auth_provider: "password",
      },
    ];
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: "u1", email: "org@wits.ac.za" },
        session: { access_token: "token" },
      },
      error: null,
    });
  }

  test("a pending organiser is blocked with the awaiting-approval message", async () => {
    seedOrganiser();
    tables.organiser_requests = [
      { id: 1, user_id: "u1", course_id: 7, status: "pending" },
    ];

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "org@wits.ac.za", password: "pw" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/awaiting approval/);
  });

  test("a denied organiser is blocked", async () => {
    seedOrganiser();
    tables.organiser_requests = [
      { id: 1, user_id: "u1", course_id: 7, status: "denied" },
    ];

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "org@wits.ac.za", password: "pw" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Your organiser request was denied.");
  });

  // An approved row wins even if another request is still pending — once
  // any course is granted the organiser can sign in, scoped to it.
  test("an approved organiser signs in with exactly their approved course ids", async () => {
    seedOrganiser();
    tables.organiser_requests = [
      { id: 1, user_id: "u1", course_id: 7, status: "approved" },
      { id: 2, user_id: "u1", course_id: 9, status: "pending" },
    ];

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "org@wits.ac.za", password: "pw" });

    expect(res.status).toBe(200);
    expect(res.body.user.courseIds).toEqual([7]);
  });

  test("a legacy organiser with no request rows keeps full access", async () => {
    seedOrganiser();

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "org@wits.ac.za", password: "pw" });

    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty("courseIds");
  });
});
