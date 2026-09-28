// timetable-parser.js is the pipeline behind timetable.html's "Import a
// timetable PDF" button: it renders each PDF page to a canvas, OCRs it with
// Tesseract, and rebuilds the weekly class grid from the OCR word boxes. The
// pdf.js / Tesseract CDN imports can't run under Jest, so loadPdfjs() and
// loadTesseract() are stubbed — appended after the real source so, in the
// one eval scope, the later function declarations win. Everything else (the
// word-box clustering in parseGridWords(), mergeEntries()'s venue merging,
// firstOccurrenceOnOrAfter()'s date math, and parseTimetablePdf()'s own
// control flow) is the real code running inside jsdom.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const rawParserJs = fs.readFileSync(
  path.join(__dirname, "timetable-parser.js"),
  "utf8",
);

const STUBS = `
function loadPdfjs() {
  return Promise.resolve(window.__fakePdfjs);
}
function loadTesseract() {
  return Promise.resolve(window.__fakeTesseract);
}
`;

function loadParser() {
  const parserJs = rawParserJs.replace(/^export /gm, "");

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
    const win = loadParser();
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
    const win = loadParser();
    expect(
      win.__parser.parseGridWords([word("Random", 100, 0, 200, 20)]),
    ).toEqual([]);
  });

  test("parses without a day-of-month sub-row and pads single-digit times", () => {
    const win = loadParser();
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
    const win = loadParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => w.text !== "VENUES",
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block with no time line", () => {
    const win = loadParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => !/^\d{1,2}:\d{2}$/.test(w.text),
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block whose time line has fewer than two times", () => {
    const win = loadParser();
    const words = gridWords({ classes: [{ cx: 200, y0: 60 }] }).filter(
      (w) => w.text !== "12:00",
    );
    expect(win.__parser.parseGridWords(words)).toEqual([]);
  });

  test("skips a block that starts with its own time line (no title)", () => {
    const win = loadParser();
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
    const win = loadParser();
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
    const win = loadParser();
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
    const win = loadParser();
    const merged = win.__parser.mergeEntries([entry("WSS2"), entry("WSS2")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].venue).toBe("WSS2");
  });

  test("keeps distinct classes separate", () => {
    const win = loadParser();
    const other = { ...entry("WSS2"), startTime: "13:00", endTime: "14:00" };
    expect(win.__parser.mergeEntries([entry("WSS2"), other])).toHaveLength(2);
  });
});

// --- firstOccurrenceOnOrAfter() -------------------------------------------

describe("timetable-parser firstOccurrenceOnOrAfter", () => {
  test("returns the start date itself when it already matches the weekday", () => {
    const win = loadParser();
    // 2026-09-01 is a Tuesday (dayOfWeek 2).
    expect(win.__parser.firstOccurrenceOnOrAfter("2026-09-01", 2)).toBe(
      "2026-09-01",
    );
  });

  test("returns the next matching weekday after the start date", () => {
    const win = loadParser();
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
    const win = loadParser();
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

    expect(messages).toEqual([
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
    const win = loadParser();
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
    const win = loadParser();
    win.__fakePdfjs = fakePdfjs(1);
    win.__fakeTesseract = fakeTesseract([{}]);

    await expect(win.__parser.parseTimetablePdf(fakeFile())).resolves.toEqual(
      [],
    );
  });
});
