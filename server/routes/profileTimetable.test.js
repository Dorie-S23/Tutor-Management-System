const express = require("express");
const request = require("supertest");
const { fakeSupabase } = require("../testUtils/fakeSupabase");

let storageFiles;
let mockSupabase;

// The route module grabs the Supabase client via `require("../supabaseClient")`
// at load time, so the mock has to be in place before it's required below.
jest.mock("../supabaseClient", () => ({
  from: (...args) => mockSupabase.from(...args),
  storage: { from: (...args) => mockSupabase.storage.from(...args) },
}));

const profileTimetableRouter = require("./profileTimetable");
const { listTranscripts } = require("./transcriptStorage");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/profile/:userId/timetable", profileTimetableRouter);
  return app;
}

const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from("fake timetable"),
]);

const storedPaths = () =>
  storageFiles.transcripts.map((file) =>
    typeof file === "string" ? file : file.name,
  );

beforeEach(() => {
  storageFiles = { transcripts: [] };
  mockSupabase = fakeSupabase({}, {}, storageFiles);
});

describe("GET /api/profile/:userId/timetable", () => {
  test("reports nothing saved for a user with no timetable", async () => {
    const res = await request(buildApp()).get("/api/profile/user-1/timetable");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: false });
  });

  test("ignores the user's transcript sitting in the same folder", async () => {
    storageFiles.transcripts.push("user-1/transcript.pdf");

    const res = await request(buildApp()).get("/api/profile/user-1/timetable");

    expect(res.body).toEqual({ uploaded: false });
  });

  test("reports the timetable on file", async () => {
    storageFiles.transcripts.push({
      name: "user-1/timetable.pdf",
      updatedAt: "2026-10-08T09:00:00.000Z",
      metadata: { size: 3652, mimetype: "application/pdf" },
    });

    const res = await request(buildApp()).get("/api/profile/user-1/timetable");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uploaded: true,
      fileName: "timetable.pdf",
      size: 3652,
      updatedAt: "2026-10-08T09:00:00.000Z",
    });
  });
});

describe("POST /api/profile/:userId/timetable", () => {
  test("stores the PDF at <userId>/timetable.pdf", async () => {
    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      uploaded: true,
      fileName: "timetable.pdf",
      size: PDF_BYTES.length,
    });
    expect(storedPaths()).toEqual(["user-1/timetable.pdf"]);
    expect(storageFiles.transcripts[0].metadata.mimetype).toBe(
      "application/pdf",
    );
  });

  test("replaces an existing timetable", async () => {
    storageFiles.transcripts.push("user-1/timetable.pdf");

    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(201);
    expect(storedPaths()).toEqual(["user-1/timetable.pdf"]);
    expect(storageFiles.transcripts[0].metadata.size).toBe(PDF_BYTES.length);
  });

  test("leaves the transcript alone and doesn't count as one", async () => {
    storageFiles.transcripts.push("user-1/transcript.pdf");

    await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(storedPaths()).toEqual([
      "user-1/transcript.pdf",
      "user-1/timetable.pdf",
    ]);
    const { files } = await listTranscripts("user-1");
    expect(files.map((file) => file.name)).toEqual(["transcript.pdf"]);
  });

  test("rejects a non-PDF content type", async () => {
    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "image/png")
      .send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Your timetable must be a PDF.");
    expect(storedPaths()).toEqual([]);
  });

  test("rejects bytes that aren't really a PDF", async () => {
    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("not a pdf"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a PDF/);
    expect(storedPaths()).toEqual([]);
  });

  test("rejects an upload over the 5 MB limit", async () => {
    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/5 MB/);
    expect(storedPaths()).toEqual([]);
  });
});

describe("GET /api/profile/:userId/timetable/signed-url", () => {
  test("returns a short-lived URL for the timetable on file", async () => {
    storageFiles.transcripts.push("user-1/timetable.pdf");

    const res = await request(buildApp()).get(
      "/api/profile/user-1/timetable/signed-url",
    );

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("user-1/timetable.pdf");
    expect(res.body.expiresIn).toBe(300);
  });

  test("404s when no timetable is on file", async () => {
    storageFiles.transcripts.push("user-1/transcript.pdf");

    const res = await request(buildApp()).get(
      "/api/profile/user-1/timetable/signed-url",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No timetable on file.");
  });
});

describe("DELETE /api/profile/:userId/timetable", () => {
  test("removes only the timetable", async () => {
    storageFiles.transcripts.push(
      "user-1/transcript.pdf",
      "user-1/timetable.pdf",
      "user-2/timetable.pdf",
    );

    const res = await request(buildApp()).delete(
      "/api/profile/user-1/timetable",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uploaded: false });
    expect(storedPaths()).toEqual([
      "user-1/transcript.pdf",
      "user-2/timetable.pdf",
    ]);
  });

  test("is a no-op when nothing is on file", async () => {
    const res = await request(buildApp()).delete(
      "/api/profile/user-1/timetable",
    );

    expect(res.status).toBe(200);
  });
});

describe("when the storage bucket hasn't been created", () => {
  let errorSpy;

  beforeEach(() => {
    storageFiles.transcripts = null;
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("an upload answers 503 with the setup hint", async () => {
    const res = await request(buildApp())
      .post("/api/profile/user-1/timetable")
      .set("Content-Type", "application/pdf")
      .send(PDF_BYTES);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/isn't set up yet/);
  });

  test("a delete answers 503 with the setup hint", async () => {
    const res = await request(buildApp()).delete(
      "/api/profile/user-1/timetable",
    );

    expect(res.status).toBe(503);
  });
});
