// Both halves of timetable-parser.js are exercised here, each loading the
// real browser ES module into a jsdom window (stripping `export`, which
// classic eval'd scripts don't support):
//
//  - the server-AI path: parseTimetablePdfWithGemini() uploads the PDF to
//    /api/timetable/parse and maps the server's classes back into calendar
//    entries (loadGeminiParser below); and
//  - the client-side OCR pipeline behind timetable.html's "Import a
//    timetable PDF" button: pdf.js / Tesseract CDN imports can't run under
//    Jest, so loadPdfjs() and loadTesseract() are stubbed — appended after
//    the real source so, in the one eval scope, the later function
//    declarations win. Everything else (the word-box clustering in
//    parseGridWords(), mergeEntries()'s venue merging,
//    firstOccurrenceOnOrAfter()'s date math, and parseTimetablePdf()'s own
//    control flow) is the real code running inside jsdom (loadOcrParser
//    below).
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const rawParserJs = fs.readFileSync(
  path.join(__dirname, "timetable-parser.js"),
  "utf8",
);

// The `export` keyword is all that separates the module from a classic
// script, which is what both loaders below eval in their jsdom windows.
const parserJs = rawParserJs.replace(/^export /gm, "");

// --- server-AI path: parseTimetablePdfWithGemini() -------------------------

const EXPORTED_NAMES = [
  "parseTimetablePdfWithGemini",
  "firstOccurrenceOnOrAfter",
];

function loadGeminiParser(fetchImpl) {
  const testHooks = `globalThis.__parser = { ${EXPORTED_NAMES.join(", ")} };`;

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/calendar.html",
    runScripts: "dangerously",
  });

  dom.window.fetch = fetchImpl;
  dom.window.eval(
    `${parserJs}\n${testHooks}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "timetable-parser.js")).href}`,
  );
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
    const { parseTimetablePdfWithGemini } = loadGeminiParser(fetchMock);

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
    const { parseTimetablePdfWithGemini } = loadGeminiParser(fetchMock);

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
    const { parseTimetablePdfWithGemini } = loadGeminiParser(fetchMock);

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
    const { parseTimetablePdfWithGemini } = loadGeminiParser(fetchMock);

    const err = await parseTimetablePdfWithGemini(THE_FILE).catch((e) => e);

    expect(err.aiUnavailable).toBe(true);
  });

  test("marks the error unavailable when the route can't be reached", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("offline"));
    const { parseTimetablePdfWithGemini } = loadGeminiParser(fetchMock);

    const err = await parseTimetablePdfWithGemini(THE_FILE).catch((e) => e);

    expect(err.aiUnavailable).toBe(true);
  });
});

// --- OCR pipeline: parseGridWords(), mergeEntries(), parseTimetablePdf() ---

const STUBS = `
function loadPdfjs() {
  return Promise.resolve(window.__fakePdfjs);
}
function loadTesseract() {
  return Promise.resolve(window.__fakeTesseract);
}
`;

function loadOcrParser() {
  // renderPageToCanvas() calls canvas.getContext("2d"), which jsdom reports
  // as "Not implemented" (no canvas package) — the fake page renderer never
  // uses the context, so that one noisy error is swallowed here.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/timetable.html",
    runScripts: "dangerously",
    virtualConsole,
  });

  dom.window.eval(
    `${parserJs}\n${STUBS}\nwindow.__parser = { firstOccurrenceOnOrAfter, parseGridWords, mergeEntries, parseTimetablePdf };\n//# sourceURL=${pathToFileURL(path.join(__dirname, "timetable-parser.js")).href}`,
  );

  return dom.window;
}

// --- OCR word-box fixtures -------------------------------------------------
// parseGridWords() consumes what Tesseract would report for one rendered grid
// page: a day-name header row, a day-of-month sub-row, then per-class blocks
// shaped "title line / time range line / SYLLABUS PLUS VENUES / venue". The
// x-coordinates below sit in two simulated columns (Monday ~x200, Tuesday
// ~x400) and the y-coordinates leave the gaps the block clustering expects.

function word(text, x0, y0, x1, y1) {
  return { text, x0, y0, x1, y1 };
}

function classBlock({
  cx,
  y0,
  title = "MATH1000",
  start = "10:15",
  end = "12:00",
  venue = "WSS2",
}) {
  const words = [];
  let x = cx - 90;
  title.split(" ").forEach((token) => {
    words.push(word(token, x, y0, x + token.length * 8, y0 + 15));
    x += token.length * 8 + 6;
  });
  words.push(
    word(start, cx - 45, y0 + 25, cx - 5, y0 + 40),
    word("-", cx, y0 + 28, cx + 3, y0 + 38),
    word(end, cx + 8, y0 + 25, cx + 48, y0 + 40),
    word("SYLLABUS", cx - 70, y0 + 50, cx - 6, y0 + 65),
    word("PLUS", cx - 1, y0 + 50, cx + 31, y0 + 65),
    word("VENUES", cx + 36, y0 + 50, cx + 84, y0 + 65),
    word(venue, cx - 20, y0 + 70, cx + 20, y0 + 85),
  );
  return words;
}

function gridWords({ classes = [], withDateRow = true } = {}) {
  const words = [
    word("Monday", 180, 0, 220, 20),
    word("Tuesday", 380, 0, 420, 20),
  ];
  if (withDateRow) {
    words.push(word("10", 190, 25, 210, 38), word("Aug", 390, 25, 410, 38));
  }
  classes.forEach((cls) => words.push(...classBlock(cls)));
  return words;
}

// --- fake pdf.js / Tesseract ----------------------------------------------

function fakePdfjs(pageCount) {
  return {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pageCount,
        getPage: async () => ({
          getViewport: ({ scale }) => ({
            width: 100 * scale,
            height: 200 * scale,
          }),
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
    }),
  };
}

function fakeTesseract(ocrResults) {
  const queue = [...ocrResults];
  const state = { terminated: 0 };
  return {
    state,
    createWorker: async () => ({
      recognize: async () => ({ data: queue.shift() }),
      terminate: async () => {
        state.terminated += 1;
      },
    }),
  };
}

// The nested blocks/paragraphs/lines/words shape extractWords() walks.
function ocrData(words) {
  return {
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: words.map((w) => ({
                  text: w.text,
                  bbox: { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

const fakeFile = () => ({ arrayBuffer: async () => new ArrayBuffer(8) });

// --- parseGridWords() ------------------------------------------------------

describe("timetable-parser parseGridWords", () => {
  test("reconstructs one entry per class block, filtering stray icon glyphs", () => {
    const win = loadOcrParser();
    const words = gridWords({
      classes: [
        { cx: 200, y0: 60 },
        { cx: 400, y0: 60, title: "PHYS1001", venue: "WSS1" },
      ],
    });
    // A tall lone letter — an OCR-misread icon glyph, which must be dropped
    // instead of being merged into the venue line.
    words.push(word("A", 230, 130, 245, 150));

    expect(win.__parser.parseGridWords(words)).toEqual([
      {
        title: "MATH1000",
        dayName: "Monday",
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS2",
      },
      {
        title: "PHYS1001",
        dayName: "Tuesday",
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS1",
      },
    ]);
  });

  test("returns nothing when no day-name headers are present", () => {
    const win = loadOcrParser();
    expect(
      win.__parser.parseGridWords([word("Random", 100, 0, 200, 20)]),
    ).toEqual([]);
  });

  test("parses without a day-of-month sub-row and pads single-digit times", () => {
    const win = loadOcrParser();
    const words = gridWords({
      withDateRow: false,
      classes: [{ cx: 200, y0: 60, start: "9:05" }],
    });

    expect(win.__parser.parseGridWords(words)).toEqual([
      {
        title: "MATH1000",
        dayName: "Monday",
        startTime: "09:05",
        endTime: "12:00",
        venue: "WSS2",
      },
    ]);
  });

  test("skips a block with no SYLLABUS PLUS VENUES anchor", () => {
    const win = loadOcrParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => w.text !== "VENUES",
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block with no time line", () => {
    const win = loadOcrParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => !/^\d{1,2}:\d{2}$/.test(w.text),
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block whose time line has fewer than two times", () => {
    const win = loadOcrParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => w.text !== "12:00",
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block that starts with its own time line (no title)", () => {
    const win = loadOcrParser();
    const words = [
      word("Monday", 180, 0, 220, 20),
      word("10", 190, 25, 210, 38),
      word("10:15", 155, 60, 195, 75),
      word("-", 200, 63, 203, 73),
      word("12:00", 208, 60, 248, 75),
      word("SYLLABUS", 130, 85, 194, 100),
      word("PLUS", 199, 85, 231, 100),
      word("VENUES", 236, 85, 284, 100),
      word("WSS2", 180, 105, 212, 120),
    ];
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block whose venue text is unusable", () => {
    const win = loadOcrParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60, venue: "B" }] });
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });
});

// --- mergeEntries() --------------------------------------------------------

describe("timetable-parser mergeEntries", () => {
  const entry = (venue) => ({
    title: "MATH1000",
    dayName: "Monday",
    startTime: "10:15",
    endTime: "12:00",
    venue,
  });

  test("combines parallel sections at the same day/time into one venue list", () => {
    const win = loadOcrParser();
    expect(win.__parser.mergeEntries([entry("WSS2"), entry("WSS3")])).toEqual([
      {
        title: "MATH1000",
        dayName: "Monday",
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS2/WSS3",
      },
    ]);
  });

  test("does not repeat a venue already in the combined list", () => {
    const win = loadOcrParser();
    const merged = win.__parser.mergeEntries([entry("WSS2"), entry("WSS2")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].venue).toBe("WSS2");
  });

  test("keeps distinct classes separate", () => {
    const win = loadOcrParser();
    const other = { ...entry("WSS2"), startTime: "13:00", endTime: "14:00" };
    expect(win.__parser.mergeEntries([entry("WSS2"), other])).toHaveLength(2);
  });
});

// --- firstOccurrenceOnOrAfter() -------------------------------------------

describe("timetable-parser firstOccurrenceOnOrAfter", () => {
  test("returns the start date itself when it already matches the weekday", () => {
    const win = loadOcrParser();
    // 2026-09-01 is a Tuesday (dayOfWeek 2).
    expect(win.__parser.firstOccurrenceOnOrAfter("2026-09-01", 2)).toBe(
      "2026-09-01",
    );
  });

  test("returns the next matching weekday after the start date", () => {
    const win = loadOcrParser();
    expect(win.__parser.firstOccurrenceOnOrAfter("2026-09-01", 1)).toBe(
      "2026-09-07",
    );
    expect(win.__parser.firstOccurrenceOnOrAfter("2026-09-01", 0)).toBe(
      "2026-09-06",
    );
  });
});

// --- parseTimetablePdf() ---------------------------------------------------

describe("timetable-parser parseTimetablePdf", () => {
  test("parses a single-page PDF and reports single-page progress", async () => {
    const win = loadOcrParser();
    const tesseract = fakeTesseract([
      ocrData(
        gridWords({
          classes: [
            { cx: 200, y0: 60 },
            { cx: 400, y0: 60, title: "PHYS1001", venue: "WSS1" },
          ],
        }),
      ),
    ]);
    win.__fakePdfjs = fakePdfjs(1);
    win.__fakeTesseract = tesseract;

    const messages = [];
    const classes = await win.__parser.parseTimetablePdf(fakeFile(), (msg) =>
      messages.push(msg),
    );

    // The AI reader is tried first; with fetch unavailable in jsdom it
    // announces the fallback before handing over to the OCR pipeline.
    expect(messages).toEqual([
      "Asking the AI reader to scan the PDF…",
      "AI reader unavailable — reading the PDF on this device instead…",
      "Loading PDF reader…",
      "Starting OCR…",
      "Reading timetable…",
    ]);
    expect(classes).toEqual([
      {
        title: "MATH1000",
        dayName: "Monday",
        dayOfWeek: 1,
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS2",
      },
      {
        title: "PHYS1001",
        dayName: "Tuesday",
        dayOfWeek: 2,
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS1",
      },
    ]);
    expect(tesseract.state.terminated).toBe(1);
  });

  test("merges parallel venues across pages and reports multi-page progress", async () => {
    const win = loadOcrParser();
    win.__fakePdfjs = fakePdfjs(2);
    const tesseract = fakeTesseract([
      ocrData(gridWords({ classes: [{ cx: 200, y0: 60 }] })),
      ocrData(gridWords({ classes: [{ cx: 200, y0: 60, venue: "WSS3" }] })),
    ]);
    win.__fakeTesseract = tesseract;

    const messages = [];
    const classes = await win.__parser.parseTimetablePdf(fakeFile(), (msg) =>
      messages.push(msg),
    );

    expect(messages).toEqual([
      "Asking the AI reader to scan the PDF…",
      "AI reader unavailable — reading the PDF on this device instead…",
      "Loading PDF reader…",
      "Starting OCR…",
      "Reading page 1 of 2…",
      "Reading page 2 of 2…",
    ]);
    expect(classes).toEqual([
      {
        title: "MATH1000",
        dayName: "Monday",
        dayOfWeek: 1,
        startTime: "10:15",
        endTime: "12:00",
        venue: "WSS2/WSS3",
      },
    ]);
    expect(tesseract.state.terminated).toBe(1);
  });

  test("a page with no OCR blocks yields no classes (and progress is optional)", async () => {
    const win = loadOcrParser();
    win.__fakePdfjs = fakePdfjs(1);
    win.__fakeTesseract = fakeTesseract([{}]);

    await expect(win.__parser.parseTimetablePdf(fakeFile())).resolves.toEqual(
      [],
    );
  });
});
