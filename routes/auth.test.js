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
  tables = { users: [] };
  mockSupabase = fakeSupabase(tables);
  mockSupabase.auth = {
    signInWithPassword: jest.fn(),
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
