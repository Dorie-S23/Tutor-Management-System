const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const auditLogRouter = require("./auditLog");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/audit-log", auditLogRouter);
  return app;
}

beforeEach(() => {
  tables = { audit_log: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/audit-log", () => {
  beforeEach(() => {
    tables.audit_log = [
      {
        id: 1,
        entity_type: "tutor_subject_preference",
        entity_id: "app-1",
        action: "approved",
        actor_id: "organiser-1",
        before: { status: "pending" },
        after: { status: "approved" },
        created_at: "2026-01-01T10:00:00Z",
        users: { name: "Organiser One", email: "org1@example.com" },
      },
      {
        id: 2,
        entity_type: "course_volunteers",
        entity_id: "vol-1",
        action: "claimed",
        actor_id: "student-1",
        before: { status: "open" },
        after: { status: "pending" },
        created_at: "2026-01-02T10:00:00Z",
        users: { name: "Student One", email: "s1@example.com" },
      },
      {
        id: 3,
        entity_type: "tutor_subject_preference",
        entity_id: "app-2",
        action: "rejected",
        actor_id: "organiser-1",
        before: { status: "pending" },
        after: { status: "rejected" },
        created_at: "2026-01-03T10:00:00Z",
        users: { name: "Organiser One", email: "org1@example.com" },
      },
    ];
  });

  test("returns every entry, newest first", async () => {
    const res = await request(buildApp()).get("/api/audit-log");

    expect(res.status).toBe(200);
    expect(res.body.map((entry) => entry.id)).toEqual([3, 2, 1]);
  });

  test("filters by entityType", async () => {
    const res = await request(buildApp()).get(
      "/api/audit-log?entityType=course_volunteers",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].entity_id).toBe("vol-1");
  });

  test("filters by entityId, showing that record's full history", async () => {
    const res = await request(buildApp()).get(
      "/api/audit-log?entityType=tutor_subject_preference&entityId=app-1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe("approved");
  });

  test("caps results at the requested limit", async () => {
    const res = await request(buildApp()).get("/api/audit-log?limit=2");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((entry) => entry.id)).toEqual([3, 2]);
  });

  test("ignores a nonsense limit and falls back to the default", async () => {
    const res = await request(buildApp()).get("/api/audit-log?limit=banana");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });
});
