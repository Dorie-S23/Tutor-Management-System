// timetable-parser.js is a browser ES module; as with sessionTiming.test.js
// the real source is loaded into a jsdom window (stripping `export`, which
// classic eval'd scripts don't support) so the exported functions run exactly
// as they do in the browser. Only the server-AI path is exercised here — the
// OCR fallback needs real canvas + WASM workers and is verified manually.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const rawParserJs = fs.readFileSync(
  path.join(__dirname, "timetable-parser.js"),
  "utf8",
);

const EXPORTED_NAMES = [
  "parseTimetablePdfWithGemini",
  "firstOccurrenceOnOrAfter",
];

function loadParser(fetchImpl) {
  const parserJs = rawParserJs.replace(
    /^export (const|function|async function)/gm,
    "$1",
  );
  const testHooks = `globalThis.__parser = { ${EXPORTED_NAMES.join(", ")} };`;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/calendar.html",
    runScripts: "dangerously",
  });

  dom.window.fetch = fetchImpl;
  dom.window.eval(`${parserJs}\n${testHooks}`);
  return dom.window.__parser;
}

const THE_FILE = { name: "timetable.pdf" };

function okResponse(classes) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ classes }),
  };
}

describe("parseTimetablePdfWithGemini", () => {
  test("uploads the PDF and maps the server's classes into calendar entries", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okResponse([
        {
          courseCode: "COMS3011A",
          courseName: "Software Design Project III",
          dayName: "Monday",
          startTime: "10:15",
          endTime: "12:00",
          venue: "MSL004",
        },
      ]),
    );
    const { parseTimetablePdfWithGemini } = loadParser(fetchMock);

    const classes = await parseTimetablePdfWithGemini(THE_FILE);

    expect(classes).toEqual([
      {
        title: "COMS3011A - Software Design Project III",
        dayName: "Monday",
        dayOfWeek: 1,
        startTime: "10:15",
        endTime: "12:00",
        venue: "MSL004",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/timetable/parse",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: THE_FILE,
      }),
    );
  });

  test("uses the course name alone when there's no code", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okResponse([
        {
          courseCode: "",
          courseName: "AA Tutorial",
          dayName: "Friday",
          startTime: "08:00",
          endTime: "09:00",
          venue: "",
        },
      ]),
    );
    const { parseTimetablePdfWithGemini } = loadParser(fetchMock);

    const [cls] = await parseTimetablePdfWithGemini(THE_FILE);

    expect(cls.title).toBe("AA Tutorial");
    expect(cls.dayOfWeek).toBe(5);
    expect(cls.venue).toBe("");
  });

  test("throws the server's message, not marked unavailable, when the file itself was rejected", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Uploaded file must be a PDF." }),
    });
    const { parseTimetablePdfWithGemini } = loadParser(fetchMock);

    const err = await parseTimetablePdfWithGemini(THE_FILE).catch((e) => e);

    expect(err.message).toBe("Uploaded file must be a PDF.");
    expect(err.aiUnavailable).toBe(false);
  });

  test("marks the error unavailable when the route isn't configured", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Timetable AI parsing is not configured…" }),
    });
    const { parseTimetablePdfWithGemini } = loadParser(fetchMock);

    const err = await parseTimetablePdfWithGemini(THE_FILE).catch((e) => e);

    expect(err.aiUnavailable).toBe(true);
  });

  test("marks the error unavailable when the route can't be reached", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("offline"));
    const { parseTimetablePdfWithGemini } = loadParser(fetchMock);

    const err = await parseTimetablePdfWithGemini(THE_FILE).catch((e) => e);

    expect(err.aiUnavailable).toBe(true);
  });
});
