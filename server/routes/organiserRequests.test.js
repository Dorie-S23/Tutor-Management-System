const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let tables;
let mockSupabase;

// The route — and the notifications helper it calls — grab the Supabase
// client via `require("../supabaseClient")` at load time, so the mock has to
// be in place before they're required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
}));

const organiserRequestsRouter = require("./organiserRequests");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organiser-requests", organiserRequestsRouter);
  return app;
}

beforeEach(() => {
  tables = {
    users: [
      {
        id: "admin1",
        name: "Super Org",
        email: "admin@wits.ac.za",
        role: "super_organiser",
      },
    ],
    courses: [
      { id: 7, course_code: "COS132", course_name: "Imperative Programming" },
      { id: 8, course_code: "COS2011", course_name: "Data Structures" },
    ],
    organiser_requests: [],
    notifications: [],
  };
  mockSupabase = fakeSupabase(tables);
});

function seedOrganiser() {
  tables.users.push({
    id: "org1",
    name: "Olive",
    email: "o@wits.ac.za",
    role: "organiser",
  });
}

describe("GET /api/organiser-requests", () => {
  test("rejects a request with no reviewer", async () => {
    const res = await request(buildApp()).get("/api/organiser-requests");

    expect(res.status).toBe(403);
  });

  test("rejects a reviewer who isn't the super-organiser", async () => {
    tables.users.push({
      id: "org1",
      name: "Olive",
      email: "o@wits.ac.za",
      role: "organiser",
    });

    const res = await request(buildApp()).get(
      "/api/organiser-requests?reviewerId=org1",
    );

    expect(res.status).toBe(403);
  });

  test("returns every request newest-first with user and course stitched on", async () => {
    tables.users.push({
      id: "org1",
      name: "Olive",
      email: "o@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 7,
        status: "pending",
        created_at: "2026-09-10T09:00:00.000Z",
      },
      {
        id: 2,
        user_id: "org1",
        course_id: 7,
        status: "approved",
        created_at: "2026-09-20T09:00:00.000Z",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/organiser-requests?reviewerId=admin1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(2);
    expect(res.body[0].user).toMatchObject({ id: "org1", name: "Olive" });
    expect(res.body[0].course).toMatchObject({ id: 7, course_code: "COS132" });
  });
});

describe("POST /api/organiser-requests/:id/approve", () => {
  beforeEach(() => {
    tables.users.push({
      id: "org1",
      name: "Olive",
      email: "o@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 7,
        status: "pending",
        created_at: "2026-09-10T09:00:00.000Z",
      },
    ];
  });

  test("approves a pending request, stamps the reviewer, notifies the requester", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests/1/approve")
      .send({ reviewerId: "admin1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 1,
      status: "approved",
      reviewed_by: "admin1",
    });
    expect(res.body.reviewed_at).toBeTruthy();
    expect(tables.organiser_requests[0].status).toBe("approved");
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]).toMatchObject({
      user_id: "org1",
      type: "organiser_request",
      related_entity: "organiser_request",
      related_id: "1",
      read: false,
    });
    expect(tables.notifications[0].message).toMatch(/COS132/);
    expect(tables.notifications[0].message).toMatch(/approved/);
  });

  test("only the super-organiser can approve", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests/1/approve")
      .send({ reviewerId: "org1" });

    expect(res.status).toBe(403);
    expect(tables.organiser_requests[0].status).toBe("pending");
  });

  test("an unknown or non-numeric request id is a 404", async () => {
    const unknown = await request(buildApp())
      .post("/api/organiser-requests/999/approve")
      .send({ reviewerId: "admin1" });
    const nonsense = await request(buildApp())
      .post("/api/organiser-requests/abc/approve")
      .send({ reviewerId: "admin1" });

    expect(unknown.status).toBe(404);
    expect(nonsense.status).toBe(404);
  });

  test("a request that was already reviewed is a 409, not a rewrite", async () => {
    tables.organiser_requests[0].status = "approved";

    const res = await request(buildApp())
      .post("/api/organiser-requests/1/approve")
      .send({ reviewerId: "admin1" });

    expect(res.status).toBe(409);
  });
});

describe("POST /api/organiser-requests/:id/deny", () => {
  beforeEach(() => {
    tables.users.push({
      id: "org1",
      name: "Olive",
      email: "o@wits.ac.za",
      role: "organiser",
    });
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 7,
        status: "pending",
        created_at: "2026-09-10T09:00:00.000Z",
      },
    ];
  });

  test("denies a pending request and tells the requester", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests/1/deny")
      .send({ reviewerId: "admin1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 1,
      status: "denied",
      reviewed_by: "admin1",
    });
    expect(tables.organiser_requests[0].status).toBe("denied");
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0].message).toMatch(/denied/);
  });
});

describe("POST /api/organiser-requests (additional access)", () => {
  beforeEach(seedOrganiser);

  test("files a kind=access request and notifies the super-organiser", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: 8 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      user_id: "org1",
      course_id: 8,
      status: "pending",
      kind: "access",
    });
    expect(tables.organiser_requests).toHaveLength(1);
    expect(tables.notifications).toHaveLength(1);
    expect(tables.notifications[0]).toMatchObject({
      user_id: "admin1",
      type: "organiser_request",
    });
    expect(tables.notifications[0].message).toMatch(/Olive/);
    expect(tables.notifications[0].message).toMatch(/COS2011/);
    expect(tables.notifications[0].message).toMatch(/additional access/);
  });

  test("rejects callers that aren't a plain organiser", async () => {
    const anon = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ courseId: 8 });
    const superOrg = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "admin1", courseId: 8 });
    const stranger = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "ghost", courseId: 8 });

    expect(anon.status).toBe(403);
    expect(superOrg.status).toBe(403);
    expect(stranger.status).toBe(403);
    expect(tables.organiser_requests).toHaveLength(0);
  });

  test("validates the course id and rejects unknown courses", async () => {
    const badId = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: "abc" });
    const missing = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: 999 });

    expect(badId.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(tables.organiser_requests).toHaveLength(0);
  });

  test("409s (with the row status) when access is already approved or pending", async () => {
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 8,
        status: "approved",
        kind: "access",
      },
    ];

    const approved = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: 8 });

    expect(approved.status).toBe(409);
    expect(approved.body.status).toBe("approved");

    tables.organiser_requests[0].status = "pending";

    const pending = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: 8 });

    expect(pending.status).toBe(409);
    expect(pending.body.status).toBe("pending");
    expect(tables.organiser_requests).toHaveLength(1);
  });

  test("a denied request is re-filed as pending instead of duplicated", async () => {
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 8,
        status: "denied",
        kind: "access",
        created_at: "2026-09-10T09:00:00.000Z",
        reviewed_at: "2026-09-11T09:00:00.000Z",
        reviewed_by: "admin1",
      },
    ];

    const res = await request(buildApp())
      .post("/api/organiser-requests")
      .send({ userId: "org1", courseId: 8 });

    expect(res.status).toBe(200);
    expect(tables.organiser_requests).toHaveLength(1);
    expect(tables.organiser_requests[0]).toMatchObject({
      id: 1,
      status: "pending",
      kind: "access",
      reviewed_at: null,
      reviewed_by: null,
    });
  });
});

describe("GET /api/organiser-requests/mine", () => {
  beforeEach(seedOrganiser);

  test("requires a known userId", async () => {
    const anon = await request(buildApp()).get("/api/organiser-requests/mine");
    const stranger = await request(buildApp()).get(
      "/api/organiser-requests/mine?userId=ghost",
    );

    expect(anon.status).toBe(400);
    expect(stranger.status).toBe(403);
  });

  test("returns only the caller's request rows", async () => {
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 7,
        status: "pending",
        kind: "access",
      },
      {
        id: 2,
        user_id: "admin1",
        course_id: 7,
        status: "pending",
      },
    ];

    const res = await request(buildApp()).get(
      "/api/organiser-requests/mine?userId=org1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ course_id: 7, status: "pending" });
  });
});

describe("kind-aware review notifications", () => {
  beforeEach(() => {
    seedOrganiser();
    tables.organiser_requests = [
      {
        id: 1,
        user_id: "org1",
        course_id: 7,
        status: "pending",
        kind: "access",
        created_at: "2026-09-10T09:00:00.000Z",
      },
    ];
  });

  test("approving additional access tells the organiser to sign in again", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests/1/approve")
      .send({ reviewerId: "admin1" });

    expect(res.status).toBe(200);
    expect(tables.notifications[0].message).toMatch(/COS132/);
    expect(tables.notifications[0].message).toMatch(/sign in again/);
  });

  test("denying additional access names the course", async () => {
    const res = await request(buildApp())
      .post("/api/organiser-requests/1/deny")
      .send({ reviewerId: "admin1" });

    expect(res.status).toBe(200);
    expect(tables.notifications[0].message).toMatch(
      /access to COS132 was denied/,
    );
  });
});
