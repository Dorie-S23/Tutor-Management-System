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

const notificationsRouter = require("./notifications");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  return app;
}

beforeEach(() => {
  tables = { notifications: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/notifications", () => {
  test("requires userId", async () => {
    const res = await request(buildApp()).get("/api/notifications");
    expect(res.status).toBe(400);
  });

  test("returns only this user's notifications, newest first", async () => {
    tables.notifications = [
      {
        id: 1,
        user_id: "u1",
        type: "session_change",
        message: "old",
        read: false,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        user_id: "u2",
        type: "session_change",
        message: "not yours",
        read: false,
        created_at: "2026-01-02T00:00:00Z",
      },
      {
        id: 3,
        user_id: "u1",
        type: "session_change",
        message: "new",
        read: false,
        created_at: "2026-01-03T00:00:00Z",
      },
    ];

    const res = await request(buildApp()).get("/api/notifications?userId=u1");

    expect(res.status).toBe(200);
    expect(res.body.map((n) => n.id)).toEqual([3, 1]);
  });
});

describe("PATCH /api/notifications/:id", () => {
  test("requires read to be a boolean", async () => {
    const res = await request(buildApp())
      .patch("/api/notifications/1")
      .send({});
    expect(res.status).toBe(400);
  });

  test("marks a notification read", async () => {
    tables.notifications = [
      { id: 1, user_id: "u1", type: "x", message: "m", read: false },
    ];

    const res = await request(buildApp())
      .patch("/api/notifications/1")
      .send({ read: true });

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
    expect(tables.notifications[0].read).toBe(true);
  });

  test("returns 404 for a notification that doesn't exist", async () => {
    const res = await request(buildApp())
      .patch("/api/notifications/999")
      .send({ read: true });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/notifications/read-all", () => {
  test("requires userId", async () => {
    const res = await request(buildApp())
      .patch("/api/notifications/read-all")
      .send({});
    expect(res.status).toBe(400);
  });

  test("marks only this user's unread notifications read, leaving others untouched", async () => {
    tables.notifications = [
      { id: 1, user_id: "u1", type: "x", message: "a", read: false },
      { id: 2, user_id: "u1", type: "x", message: "b", read: true },
      { id: 3, user_id: "u2", type: "x", message: "c", read: false },
    ];

    const res = await request(buildApp())
      .patch("/api/notifications/read-all")
      .send({ userId: "u1" });

    expect(res.status).toBe(204);
    expect(tables.notifications.map((n) => n.read)).toEqual([
      true, // u1's unread -> read
      true, // u1's already-read -> unchanged
      false, // u2's untouched
    ]);
  });

  // Route ordering regression guard: /:id is registered after /read-all in
  // notifications.js specifically so a PATCH to /read-all doesn't get
  // swallowed by :id="read-all" and 400 on "read must be a boolean".
  test("isn't shadowed by the /:id route", async () => {
    const res = await request(buildApp())
      .patch("/api/notifications/read-all")
      .send({ userId: "u1" });
    expect(res.status).not.toBe(400);
  });
});
