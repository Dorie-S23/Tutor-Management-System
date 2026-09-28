const express = require("express");
const request = require("supertest");

const timetableRouter = require("./timetable");

// The route calls the real global fetch; every test swaps in a jest.fn() so
// nothing ever leaves the test process. The real one is restored at the end.
const realFetch = global.fetch;
const ORIGINAL_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_MODEL = process.env.GEMINI_MODEL;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/timetable", timetableRouter);
  return app;
}

// A few bytes that pass the route's "%PDF-" magic check — the content itself
// is never really parsed, it's just forwarded to the mocked Gemini call.
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
);

function validClass(overrides = {}) {
  return {
    courseCode: "COMS3011A",
    courseName: "Software Design Project III",
    dayName: "Monday",
    startTime: "10:15",
    endTime: "12:00",
    venue: "MSL004",
    ...overrides,
  };
}

function geminiOk(classes) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ classes }) }] } },
      ],
    }),
  };
}

function postPdf(app, body = PDF_BYTES) {
  return request(app)
    .post("/api/timetable/parse")
    .set("Content-Type", "application/pdf")
    .send(body);
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
  global.fetch = jest.fn();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  global.fetch = realFetch;
  if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_MODEL === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = ORIGINAL_MODEL;
});

describe("POST /api/timetable/parse", () => {
  test("rejects an upload that isn't a PDF", async () => {
    const res = await request(buildApp())
      .post("/api/timetable/parse")
      .send({ file: "pretend-pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a PDF/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects an empty body", async () => {
    const res = await postPdf(buildApp(), Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a PDF/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("rejects bytes that don't contain the PDF magic header", async () => {
    const res = await postPdf(buildApp(), Buffer.from("plain text, not a pdf"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/doesn't look like a PDF/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns 503 when GEMINI_API_KEY is not configured", async () => {
    delete process.env.GEMINI_API_KEY;

    const res = await postPdf(buildApp());

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/GEMINI_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns the extracted classes, normalised", async () => {
    global.fetch.mockResolvedValue(
      geminiOk([
        {
          courseCode: " COMS3011A ",
          courseName: " Software Design Project III ",
          dayName: " monday ",
          startTime: "9:05",
          endTime: "12:00",
          venue: " MSL004 ",
        },
        {
          courseCode: "",
          courseName: "AA Tutorial",
          dayName: "Tuesday",
          startTime: "14:00",
          endTime: "15:45",
          venue: "",
        },
      ]),
    );

    const res = await postPdf(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.classes).toEqual([
      {
        courseCode: "COMS3011A",
        courseName: "Software Design Project III",
        dayName: "Monday",
        startTime: "09:05",
        endTime: "12:00",
        venue: "MSL004",
      },
      {
        courseCode: "",
        courseName: "AA Tutorial",
        dayName: "Tuesday",
        startTime: "14:00",
        endTime: "15:45",
        venue: "",
      },
    ]);
  });

  test("sorts classes by day and start time", async () => {
    global.fetch.mockResolvedValue(
      geminiOk([
        validClass({ dayName: "Wednesday", startTime: "08:00" }),
        validClass({ dayName: "Monday", startTime: "14:00" }),
        validClass({ dayName: "Monday", startTime: "08:00" }),
      ]),
    );

    const res = await postPdf(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.classes.map((c) => `${c.dayName} ${c.startTime}`)).toEqual([
      "Monday 08:00",
      "Monday 14:00",
      "Wednesday 08:00",
    ]);
  });

  test("drops rows with an unusable day, time, or name but keeps the rest", async () => {
    global.fetch.mockResolvedValue(
      geminiOk([
        validClass({ dayName: "Funday" }),
        validClass({ startTime: "25:00" }),
        validClass({ endTime: "noon" }),
        validClass({ courseCode: "", courseName: "" }),
        validClass({ dayName: "Tuesday" }),
      ]),
    );

    const res = await postPdf(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.classes).toHaveLength(1);
    expect(res.body.classes[0].dayName).toBe("Tuesday");
  });

  test("sends the PDF to Gemini as inline data with the structured-output schema", async () => {
    global.fetch.mockResolvedValue(geminiOk([validClass()]));

    await postPdf(buildApp());

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    expect(options.method).toBe("POST");
    expect(options.headers["x-goog-api-key"]).toBe("test-key");

    const body = JSON.parse(options.body);
    const parts = body.contents[0].parts;
    expect(parts[0].inlineData).toEqual({
      mimeType: "application/pdf",
      data: PDF_BYTES.toString("base64"),
    });
    expect(parts[1].text).toMatch(/timetable/i);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toEqual([
      "classes",
    ]);
  });

  test("uses GEMINI_MODEL to override the default model", async () => {
    process.env.GEMINI_MODEL = "gemini-3.8-flash";
    global.fetch.mockResolvedValue(geminiOk([validClass()]));

    await postPdf(buildApp());

    expect(global.fetch.mock.calls[0][0]).toContain(
      "models/gemini-3.8-flash:generateContent",
    );
  });

  test("joins split text parts and ignores thought parts", async () => {
    const json = JSON.stringify({ classes: [validClass()] });
    const midpoint = Math.floor(json.length / 2);

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "internal reasoning…" },
                { text: json.slice(0, midpoint) },
                { text: json.slice(midpoint) },
              ],
            },
          },
        ],
      }),
    });

    const res = await postPdf(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.classes).toHaveLength(1);
  });

  test("returns 502 without retrying when the key is rate-limited", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "quota exceeded",
    });

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/AI reader/);
    // A quota window is minutes long — a 2-second retry can't outwait it, so
    // the route fails fast and the client falls back to OCR.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("gives up with 502 when even the retries keep hitting 5xx", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    // Two retries on top of the first attempt, all three consumed by the
    // persistent error the mock keeps returning.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test("retries a transient Gemini overload and succeeds on a later attempt", async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "high demand",
      })
      .mockResolvedValueOnce(geminiOk([validClass()]));

    const res = await postPdf(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.classes).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("does not retry a request Gemini itself rejected", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "INVALID_ARGUMENT",
    });

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns 502 when the model's reply isn't the expected JSON", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "no idea, sorry" }] } }],
      }),
    });

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/find any classes/);
  });

  test("returns 502 when every extracted row is unusable", async () => {
    global.fetch.mockResolvedValue(
      geminiOk([validClass({ dayName: "Funday" })]),
    );

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/find any classes/);
  });

  test("returns 502 when Gemini cannot be reached", async () => {
    global.fetch.mockRejectedValue(new Error("network down"));

    const res = await postPdf(buildApp());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not reach/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("returns 413 when the upload exceeds the size limit", async () => {
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1, 0x41);

    const res = await postPdf(buildApp(), oversized);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
