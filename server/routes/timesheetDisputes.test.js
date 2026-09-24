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

const timesheetDisputesRouter = require("./timesheetDisputes");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/timesheet-disputes", timesheetDisputesRouter);
  return app;
}

beforeEach(() => {
  tables = { timesheet_disputes: [], timesheets: [], users: [] };
  mockSupabase = fakeSupabase(tables);
});

describe("GET /api/timesheet-disputes", () => {
  beforeEach(() => {
    tables.timesheet_disputes = [
      {
        id: 1,
        timesheet_user_id: "t1",
        timesheet_week_start: "2026-08-31",
        raised_by: "t1",
        message: "My Tuesday hours were correct",
        resolved: false,
        created_at: "2026-09-02T09:00:00.000Z",
      },
      {
        id: 2,
        timesheet_user_id: "t2",
        timesheet_week_start: "2026-08-31",
        raised_by: "t2",
        message: "Please recheck my approved total",
        resolved: true,
        created_at: "2026-09-01T09:00:00.000Z",
      },
    ];
  });

  test("?raisedBy=... returns just that tutor's disputes", async () => {
    const res = await request(buildApp()).get(
      "/api/timesheet-disputes?raisedBy=t1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].raised_by).toBe("t1");
  });

  test("?resolved=false returns the organiser's open queue", async () => {
    const res = await request(buildApp()).get(
      "/api/timesheet-disputes?resolved=false",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });

  test("?timesheetUserId=&weekStart= scopes to one timesheet", async () => {
    const res = await request(buildApp()).get(
      "/api/timesheet-disputes?timesheetUserId=t2&weekStart=2026-08-31",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(2);
  });

  test("returns everything when no filter is given", async () => {
    const res = await request(buildApp()).get("/api/timesheet-disputes");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("POST /api/timesheet-disputes", () => {
  test("400s when a required field is missing", async () => {
    const res = await request(buildApp())
      .post("/api/timesheet-disputes")
      .send({ timesheetUserId: "t1", timesheetWeekStart: "2026-08-31" });

    expect(res.status).toBe(400);
    expect(tables.timesheet_disputes).toHaveLength(0);
  });

  test("400s on a blank/whitespace message", async () => {
    tables.timesheets = [
      { user_id: "t1", week_start: "2026-08-31", status: "rejected" },
    ];

    const res = await request(buildApp()).post("/api/timesheet-disputes").send({
      timesheetUserId: "t1",
      timesheetWeekStart: "2026-08-31",
      raisedBy: "t1",
      message: "   ",
    });

    expect(res.status).toBe(400);
    expect(tables.timesheet_disputes).toHaveLength(0);
  });

  test("404s when the timesheet doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/timesheet-disputes").send({
      timesheetUserId: "nobody",
      timesheetWeekStart: "2026-08-31",
      raisedBy: "t1",
      message: "This isn't right",
    });

    expect(res.status).toBe(404);
  });

  test("400s when the timesheet is still pending — nothing to dispute yet", async () => {
    tables.timesheets = [
      { user_id: "t1", week_start: "2026-08-31", status: "pending" },
    ];

    const res = await request(buildApp()).post("/api/timesheet-disputes").send({
      timesheetUserId: "t1",
      timesheetWeekStart: "2026-08-31",
      raisedBy: "t1",
      message: "This isn't right",
    });

    expect(res.status).toBe(400);
    expect(tables.timesheet_disputes).toHaveLength(0);
  });

  test("raises a dispute against a reviewed timesheet, defaulting resolved to false", async () => {
    tables.timesheets = [
      { user_id: "t1", week_start: "2026-08-31", status: "rejected" },
    ];

    const res = await request(buildApp()).post("/api/timesheet-disputes").send({
      timesheetUserId: "t1",
      timesheetWeekStart: "2026-08-31",
      raisedBy: "t1",
      message: "  My Tuesday hours were correct  ",
    });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("My Tuesday hours were correct");
    expect(res.body.resolved).toBe(false);
    expect(tables.timesheet_disputes).toHaveLength(1);
  });
});

describe("PATCH /api/timesheet-disputes/:id/resolve", () => {
  // req.params.id from the URL is always a string, so the seeded row's id
  // has to be a string too — fakeSupabase does a strict === match and
  // doesn't coerce types the way Postgrest does for a real integer column.
  beforeEach(() => {
    tables.timesheet_disputes = [
      {
        id: "1",
        timesheet_user_id: "t1",
        timesheet_week_start: "2026-08-31",
        raised_by: "t1",
        message: "My Tuesday hours were correct",
        resolved: false,
        created_at: "2026-09-02T09:00:00.000Z",
      },
    ];
  });

  test("marks an open dispute resolved", async () => {
    const res = await request(buildApp()).patch(
      "/api/timesheet-disputes/1/resolve",
    );

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(tables.timesheet_disputes[0].resolved).toBe(true);
  });

  test("404s for a dispute that doesn't exist", async () => {
    const res = await request(buildApp()).patch(
      "/api/timesheet-disputes/999/resolve",
    );

    expect(res.status).toBe(404);
  });

  test("409s when the dispute is already resolved", async () => {
    tables.timesheet_disputes[0].resolved = true;

    const res = await request(buildApp()).patch(
      "/api/timesheet-disputes/1/resolve",
    );

    expect(res.status).toBe(409);
  });
});
