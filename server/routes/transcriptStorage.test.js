const { fakeSupabase } = require("../testUtils/fakeSupabase");

let storageFiles;
let mockSupabase;

// The helper grabs the Supabase client via require at load time, so the
// mock has to be in place before it's required below. A getter so the
// beforeEach reassignment of mockSupabase is always what the helper sees.
jest.mock("../supabaseClient", () => ({
  get storage() {
    return mockSupabase.storage;
  },
}));

const {
  BUCKET,
  MAX_TRANSCRIPT_BYTES,
  SIGNED_URL_EXPIRY_SECONDS,
  listTranscripts,
  hasTranscript,
  storageFailure,
} = require("./transcriptStorage");

beforeEach(() => {
  storageFiles = { transcripts: [] };
  mockSupabase = fakeSupabase({}, {}, storageFiles);
});

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("constants", () => {
  test("matches the documented storage layout", () => {
    expect(BUCKET).toBe("transcripts");
    expect(MAX_TRANSCRIPT_BYTES).toBe(5 * 1024 * 1024);
    expect(SIGNED_URL_EXPIRY_SECONDS).toBe(300);
  });
});

describe("listTranscripts", () => {
  test("returns only the transcript.* files in the user's folder", async () => {
    await mockSupabase.storage
      .from(BUCKET)
      .upload("tutor-1/transcript.pdf", "x");
    await mockSupabase.storage.from(BUCKET).upload("tutor-1/notes.txt", "x");
    await mockSupabase.storage
      .from(BUCKET)
      .upload("tutor-2/transcript.pdf", "x");

    const { files, error } = await listTranscripts("tutor-1");
    expect(error).toBeNull();
    expect(files.map((f) => f.name)).toEqual(["transcript.pdf"]);
  });

  test("sorts newest first so a lingering old extension loses", async () => {
    // Seed two files with different extensions; the newest updated_at
    // must win so a lingering old upload can't shadow the current one.
    const files = [
      { name: "tutor-1/transcript.pdf", updatedAt: "2026-01-01T00:00:00Z" },
      { name: "tutor-1/transcript.png", updatedAt: "2026-02-01T00:00:00Z" },
    ];
    storageFiles.transcripts = files;

    const { files: listed } = await listTranscripts("tutor-1");
    expect(listed.map((f) => f.name)).toEqual([
      "transcript.png",
      "transcript.pdf",
    ]);
  });

  test("treats a never-created bucket as 'no files yet', not an error", async () => {
    // Verified against real Storage: list() on a missing bucket answers
    // empty rather than erroring — only the writes fail.
    storageFiles.transcripts = null; // bucket never created

    const { files, error } = await listTranscripts("tutor-1");
    expect(files).toEqual([]);
    expect(error).toBeNull();
  });
});

describe("hasTranscript", () => {
  test("true once a transcript is on file", async () => {
    await mockSupabase.storage
      .from(BUCKET)
      .upload("tutor-1/transcript.pdf", "x");
    const { has, error } = await hasTranscript("tutor-1");
    expect(has).toBe(true);
    expect(error).toBeNull();
  });

  test("false with no error when nothing has been uploaded yet", async () => {
    const { has, error } = await hasTranscript("tutor-1");
    expect(has).toBe(false);
    expect(error).toBeNull();
  });

  test("false with no error when the bucket was never created", async () => {
    storageFiles.transcripts = null;
    const { has, error } = await hasTranscript("tutor-1");
    expect(has).toBe(false);
    expect(error).toBeNull();
  });
});

describe("storageFailure", () => {
  let consoleError;
  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  test("answers 503 with a setup hint for a missing bucket", () => {
    const res = fakeRes();
    storageFailure(res, { message: "Bucket not found" });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/bucket is missing/i);
  });

  test("answers 502 for any other storage failure", () => {
    const res = fakeRes();
    storageFailure(res, { message: "upstream timeout" });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
