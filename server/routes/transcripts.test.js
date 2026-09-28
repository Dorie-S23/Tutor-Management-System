const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let storageFiles;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
// The factory proxies to whatever `mockSupabase` currently points at, which
// beforeEach() reassigns for every test.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
  storage: { from: (...args) => mockSupabase.storage.from(...args) },
}));

const transcriptsRouter = require("./transcripts");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/transcripts", transcriptsRouter);
  return app;
}

// Minimal stand-ins for each accepted format — just enough bytes to satisfy
// the route's magic-byte check.
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from("fake transcript"),
]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake transcript"),
]);

const storedPaths = () =>
  storageFiles.transcripts.map((file) =>
    typeof file === "string" ? file : file.name,
  );

beforeEach(() => {
  // The transcripts bucket exists and starts empty for every test.
  storageFiles = { transcripts: [] };
  mockSupabase = fakeSupabase({}, {}, storageFiles);
});

describe("GET /api/transcripts/:userId", () => {
  test("reports nothing uploaded for a user with no transcript on file", async () => {
    const res = await request(buildApp()).get("/api/transcripts/user-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: false });
  });

  test("reports the transcript on record", async () => {
    storageFiles.transcripts.push("user-1/transcript.pdf");

    const res = await request(buildApp()).get("/api/transcripts/user-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uploaded: true,
      fileName: "transcript.pdf",
    });
  });
});

describe("POST /api/transcripts/:userId", () => {
  test("stores a PDF at <userId>/transcript.pdf", async () => {
    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      uploaded: true,
      fileName: "transcript.pdf",
      size: PDF_BYTES.length,
      contentType: "application/pdf",
    });
    expect(storedPaths()).toEqual(["user-1/transcript.pdf"]);
    expect(storageFiles.transcripts[0].metadata).toMatchObject({
      size: PDF_BYTES.length,
      mimetype: "application/pdf",
    });
  });

  test("stores a PNG at <userId>/transcript.png", async () => {
    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);

    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe("transcript.png");
    expect(storedPaths()).toEqual(["user-1/transcript.png"]);
  });

  test("replaces an existing transcript, even when the extension changes", async () => {
    storageFiles.transcripts.push("user-1/transcript.png");

    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(201);
    expect(storedPaths()).toEqual(["user-1/transcript.pdf"]);
  });

  test("rejects a file whose bytes don't match its content type", async () => {
    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("this is not a pdf"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like/);
    expect(storedPaths()).toEqual([]);
  });

  test("rejects an unsupported content type", async () => {
    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "text/plain")
      .send("not a transcript");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Uploaded file must be a PDF, PNG, or JPEG.");
    expect(storedPaths()).toEqual([]);
  });

  test("rejects an upload over the 5 MB limit", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);

    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "application/pdf")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/5 MB/);
    expect(storedPaths()).toEqual([]);
  });
});

describe("GET /api/transcripts/:userId/signed-url", () => {
  test("returns a short-lived URL for the transcript on file", async () => {
    storageFiles.transcripts.push("user-1/transcript.pdf");

    const res = await request(buildApp()).get(
      "/api/transcripts/user-1/signed-url",
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("user-1/transcript.pdf");
    expect(res.body.expiresIn).toBe(300);
  });

  test("404s when no transcript is on file", async () => {
    const res = await request(buildApp()).get(
      "/api/transcripts/user-1/signed-url",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No transcript on file.");
  });
});

describe("when the transcripts bucket hasn't been created", () => {
  // A missing bucket is a one-off setup problem, not the caller's fault.
  // Mirrors real Storage (verified live): list() quietly answers empty for
  // a missing bucket, so status and signed-url behave like a user with
  // nothing uploaded, and only the upload itself hits the setup error.
  let errorSpy;

  beforeEach(() => {
    storageFiles.transcripts = null;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("GET status reports nothing uploaded, like an empty bucket", async () => {
    const res = await request(buildApp()).get("/api/transcripts/user-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: false });
  });

  test("POST upload answers 503 with the setup hint", async () => {
    const res = await request(buildApp())
      .post("/api/transcripts/user-1")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/isn't set up yet/);
  });

  test("GET signed-url answers 404, like a user with no upload", async () => {
    const res = await request(buildApp()).get(
      "/api/transcripts/user-1/signed-url",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No transcript on file.");
  });
});
