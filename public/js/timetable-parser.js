// Reading timetable PDFs happens in two layers. The primary path uploads the
// PDF to our own /api/timetable/parse route, which hands it to Google's
// Gemini API — a multimodal model that reads PDFs directly (including these
// exports' outlined-shape pages, which have no text layer) and replies with
// structured JSON. When that route can't be reached, the fallback is entirely
// in-browser: render each page to a bitmap and run OCR over it — pdf.js
// (rendering) and Tesseract.js (OCR) are loaded from a CDN at parse time
// instead of shipping them in the bundle.
// The PDF never has real calendar dates attached to its weekly grid, so this
// module also computes each class's first occurrence from a user-chosen start date.

const PDFJS_VERSION = "6.3.289";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
const TESSERACT_VERSION = "7.0.0";
const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Tuned against a real Wits "My Class Schedule" PDF — see the parseGridWords
// comments below for what each one is protecting against.
const RENDER_SCALE = 3;
const ICON_GLYPH_HEIGHT = 18;
const DATE_ROW_WINDOW = 25;
const LINE_CENTER_TOLERANCE = 8;
const BLOCK_GAP_THRESHOLD = 15;
const COLUMN_EDGE_PADDING = 120;

function pad2(n) {
  return String(n).padStart(2, "0");
}

// The next date on/after startDateStr ("YYYY-MM-DD") that falls on dayOfWeek (0-6).
export function firstOccurrenceOnOrAfter(startDateStr, dayOfWeek) {
  const [y, m, d] = startDateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const diff = (dayOfWeek - start.getDay() + 7) % 7;
  start.setDate(start.getDate() + diff);
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

let pdfjsLibPromise;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(PDFJS_URL).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

let tesseractPromise;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(TESSERACT_URL).then((mod) => mod.default);
  }
  return tesseractPromise;
}

async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function extractWords(worker, canvas) {
  const { data } = await worker.recognize(
    canvas,
    {},
    { blocks: true, text: true },
  );
  const words = [];
  (data.blocks || []).forEach((block) => {
    (block.paragraphs || []).forEach((para) => {
      (para.lines || []).forEach((line) => {
        (line.words || []).forEach((w) => {
          words.push({
            text: w.text,
            x0: w.bbox.x0,
            y0: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
          });
        });
      });
    });
  });
  return words;
}

// Reconstructs weekly class blocks from OCR word boxes on one rendered grid page.
// Returns unmerged entries — parallel sections at the same day/time (scheduled
// in multiple venues at once) are still separate here; mergeEntries() combines them.
function parseGridWords(rawWords) {
  // Drop icon glyphs that OCR occasionally misreads as a lone letter (a small
  // warning-triangle icon next to a venue). They're reliably taller than
  // normal body text in this render and would otherwise bridge the gap
  // between two stacked blocks, merging them into one.
  const words = rawWords.filter(
    (w) => !(w.text.length === 1 && w.y1 - w.y0 > ICON_GLYPH_HEIGHT),
  );

  const dayHeaders = DAY_NAMES.map((name) => {
    const w = words.find(
      (w) => w.text.trim().toLowerCase() === name.toLowerCase(),
    );
    return w ? { name, cx: (w.x0 + w.x1) / 2, y1: w.y1 } : null;
  })
    .filter(Boolean)
    // Columns aren't necessarily laid out Sun-Sat left to right (this export
    // runs Mon-Sun), so the boundary math below needs them in physical x order.
    .sort((a, b) => a.cx - b.cx);

  if (dayHeaders.length === 0) return [];

  const boundaries = [dayHeaders[0].cx - COLUMN_EDGE_PADDING];
  for (let i = 0; i < dayHeaders.length - 1; i++) {
    boundaries.push((dayHeaders[i].cx + dayHeaders[i + 1].cx) / 2);
  }
  boundaries.push(dayHeaders[dayHeaders.length - 1].cx + COLUMN_EDGE_PADDING);

  function columnFor(x) {
    for (let i = 0; i < dayHeaders.length; i++) {
      if (x >= boundaries[i] && x < boundaries[i + 1])
        return dayHeaders[i].name;
    }
    return null;
  }

  // Below the day-name header sits a day-of-month sub-row (e.g. "10 Aug") —
  // tightly banded right under the header across every column. The window
  // must stay narrow: a column whose first class starts with little gap
  // after the header can otherwise get its own title line mistaken for part
  // of the date row.
  const headerBottom = Math.max(...dayHeaders.map((h) => h.y1));
  const subRowWords = words.filter(
    (w) =>
      w.y0 > headerBottom &&
      w.y0 < headerBottom + DATE_ROW_WINDOW &&
      columnFor((w.x0 + w.x1) / 2) !== null,
  );
  const contentTop =
    subRowWords.length > 0
      ? Math.max(...subRowWords.map((w) => w.y1))
      : headerBottom;

  const contentWords = words
    .filter((w) => w.y0 > contentTop && columnFor((w.x0 + w.x1) / 2) !== null)
    .map((w) => ({ ...w, day: columnFor((w.x0 + w.x1) / 2) }));

  // Group into reading-order lines: words within ~8px of a running vertical
  // center form one line, sorted left-to-right — this is what makes same-line
  // tokens (e.g. the "-" in "10:15 - 12:00") sort correctly even when their
  // own y0 jitters a few px from the digits beside them.
  function toLines(dayWords) {
    const sorted = [...dayWords].sort((a, b) => a.y0 - b.y0);
    const lines = [];
    sorted.forEach((w) => {
      const wCenter = (w.y0 + w.y1) / 2;
      const line = lines.find(
        (l) => Math.abs(l.center - wCenter) < LINE_CENTER_TOLERANCE,
      );
      if (line) {
        line.words.push(w);
        line.center =
          (line.center * (line.words.length - 1) + wCenter) / line.words.length;
        line.y0 = Math.min(line.y0, w.y0);
        line.y1 = Math.max(line.y1, w.y1);
      } else {
        lines.push({ center: wCenter, y0: w.y0, y1: w.y1, words: [w] });
      }
    });
    lines.forEach((l) => l.words.sort((a, b) => a.x0 - b.x0));
    lines.sort((a, b) => a.y0 - b.y0);
    return lines;
  }

  const byDay = {};
  contentWords.forEach((w) => {
    (byDay[w.day] ||= []).push(w);
  });

  const rawEntries = [];

  Object.entries(byDay).forEach(([day, dayWords]) => {
    const lines = toLines(dayWords);

    // Cluster lines into blocks by vertical gap.
    const blocks = [];
    lines.forEach((line) => {
      const last = blocks[blocks.length - 1];
      if (last && line.y0 - last.maxY1 <= BLOCK_GAP_THRESHOLD) {
        last.lines.push(line);
        last.maxY1 = Math.max(last.maxY1, line.y1);
      } else {
        blocks.push({ lines: [line], maxY1: line.y1 });
      }
    });

    blocks.forEach((block) => {
      const flatWords = block.lines.flatMap((l) => l.words);
      // "SYLLABUS PLUS VENUES" is fixed boilerplate this export prints under
      // every class block, so it's a reliable anchor for where the venue
      // list starts even when OCR garbles the surrounding text.
      const venuesIdx = flatWords.findIndex((w) => w.text === "VENUES");
      if (venuesIdx === -1) return;

      const timeLineIdx = block.lines.findIndex((l) =>
        l.words.some((w) => /^\d{1,2}:\d{2}$/.test(w.text)),
      );
      if (timeLineIdx === -1) return;
      const timeTokens = block.lines[timeLineIdx].words.filter((w) =>
        /^\d{1,2}:\d{2}$/.test(w.text),
      );
      if (timeTokens.length < 2) return;
      const startTime = timeTokens[0].text.padStart(5, "0");
      const endTime = timeTokens[1].text.padStart(5, "0");

      const title = block.lines
        .slice(0, timeLineIdx)
        .flatMap((l) => l.words)
        .map((w) => w.text)
        .join(" ")
        .replace(/\s*-\s*/g, " - ")
        .trim();
      if (!title) return;

      const venue = flatWords
        .slice(venuesIdx + 1)
        .filter((w) => w.text.length > 1)
        .map((w) => w.text.toUpperCase())
        .join(" ")
        .trim();
      if (!venue) return;

      rawEntries.push({ title, dayName: day, startTime, endTime, venue });
    });
  });

  return rawEntries;
}

// Parallel sections (the same class scheduled in more than one venue at the
// same day/time) show up as separate blocks — merge them into one entry with
// a combined venue list.
function mergeEntries(rawEntries) {
  const merged = new Map();
  rawEntries.forEach((e) => {
    const key = `${e.title}|${e.dayName}|${e.startTime}|${e.endTime}`;
    if (merged.has(key)) {
      const existing = merged.get(key);
      if (!existing.venue.split("/").includes(e.venue)) {
        existing.venue += `/${e.venue}`;
      }
    } else {
      merged.set(key, { ...e });
    }
  });
  return Array.from(merged.values());
}

// Composes the single display title the review table edits from the model's
// two name fields — code first when both are present.
function composeTitle(cls) {
  const code = (cls.courseCode || "").trim();
  const name = (cls.courseName || "").trim();
  if (code && name) return `${code} - ${name}`;
  return code || name;
}

// Primary parse path: the PDF is uploaded as-is to our server route, which
// sends it to Gemini and returns { classes: [{ courseCode, courseName,
// dayName, startTime, endTime, venue }] }. A 4xx means the request itself was
// rejected (wrong file type, too large) — that's thrown as definitive. 5xx or
// network failures mark `aiUnavailable` so the caller can fall back to OCR.
export async function parseTimetablePdfWithGemini(file, onProgress) {
  onProgress?.("Asking the AI reader to scan the PDF…");

  let response;
  try {
    response = await fetch("/api/timetable/parse", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
  } catch {
    const err = new Error("Could not reach the AI reader.");
    err.aiUnavailable = true;
    throw err;
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const err = new Error(
      payload?.error || "The AI reader could not read that PDF.",
    );
    err.aiUnavailable = response.status >= 500;
    throw err;
  }

  const payload = await response.json();
  return (payload.classes || []).map((cls) => ({
    title: composeTitle(cls),
    dayName: cls.dayName,
    dayOfWeek: DAY_NAMES.indexOf(cls.dayName),
    startTime: cls.startTime,
    endTime: cls.endTime,
    venue: cls.venue,
  }));
}

// Reads the PDF, preferring the server-side AI reader and falling back to the
// in-browser OCR pipeline below when the AI route is unavailable (not
// configured, rate-limited, offline…) but not when it definitively rejected
// the file (empty/broken/oversized — OCR would only fail the same way).
export async function parseTimetablePdf(file, onProgress) {
  try {
    return await parseTimetablePdfWithGemini(file, onProgress);
  } catch (err) {
    if (!err.aiUnavailable) throw err;
    onProgress?.(
      "AI reader unavailable — reading the PDF on this device instead…",
    );
  }

  onProgress?.("Loading PDF reader…");
  const [pdfjsLib, Tesseract] = await Promise.all([
    loadPdfjs(),
    loadTesseract(),
  ]);

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;

  onProgress?.("Starting OCR…");
  const worker = await Tesseract.createWorker("eng");

  const rawEntries = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      onProgress?.(
        doc.numPages > 1
          ? `Reading page ${pageNum} of ${doc.numPages}…`
          : "Reading timetable…",
      );
      const page = await doc.getPage(pageNum);
      const canvas = await renderPageToCanvas(page, RENDER_SCALE);
      const words = await extractWords(worker, canvas);
      rawEntries.push(...parseGridWords(words));
    }
  } finally {
    await worker.terminate();
  }

  return mergeEntries(rawEntries).map((cls) => ({
    title: cls.title,
    dayName: cls.dayName,
    dayOfWeek: DAY_NAMES.indexOf(cls.dayName),
    startTime: cls.startTime,
    endTime: cls.endTime,
    venue: cls.venue,
  }));
}
