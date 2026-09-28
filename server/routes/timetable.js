const express = require("express");
const { DAY_NAMES } = require("../dayNames");

const router = express.Router();

// The PDF is sent to Gemini inline as base64, which inflates it by ~33%, and
// the API caps a single (inline) request at 20 MB — 15 MB keeps the encoded
// body safely under that. Timetable exports are normally a few hundred KB.
const MAX_PDF_BYTES = 15 * 1024 * 1024;

// Google's REST endpoint for the model — called with plain fetch instead of
// the SDK so there's no extra dependency and it works in the Workers runtime.
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_TIMEOUT_MS = 90_000;

// The flash models answer 503 ("This model is currently experiencing high
// demand") in short bursts — observed live on this project's own key, where
// the same request succeeds or fails minutes apart. Google's own wording is
// that those spikes are transient, so the route retries them a couple of
// times with a short backoff; a healthy first attempt pays nothing (no delay
// is added unless Gemini answered with one of these statuses).
// 429 is deliberately NOT retried: on this key it means the free tier's
// per-minute quota is spent, and a 2-second retry can't outwait a minute —
// the client falls back to on-device OCR instead. 4xx means the request
// itself was rejected, which would fail identically on a retry.
const TRANSIENT_GEMINI_STATUSES = new Set([500, 502, 503, 504]);
const GEMINI_RETRY_DELAYS_MS = [700, 1600];

const EXTRACT_PROMPT = `This PDF is a university student's weekly class timetable. Layouts vary between exports — it may be plain text rows, or a colored grid table with day-of-week columns and time-of-day rows. Extract every distinct weekly class session shown.

For each session capture:
- courseCode: the course/module code exactly as printed (e.g. "COMS3011A"), or an empty string if the timetable only shows a name.
- courseName: the course/class name as printed (e.g. "Software Design Project III", or "AA Tutorial" when only a class-type label is shown), or an empty string if only a code is shown.
- dayName: the full day of the week it occurs on.
- startTime / endTime: 24-hour "HH:MM" times — convert anything like "10h15" or "2 PM" into that format.
- venue: the room/venue label exactly as printed (e.g. "MSL004"), or an empty string if the timetable doesn't state one. If the identical class appears in multiple venues at the exact same day and time (parallel sections), merge them into one entry with venues joined by "/".

Ignore non-class rows such as "BREAK" labels, empty cells, and the day/time headers themselves. This timetable is a weekly template with no real calendar dates attached — do not invent or guess a date. Never invent a course code, name, or venue that isn't printed in the PDF.`;

// Passed as responseJsonSchema to force Gemini's structured-output mode into
// this exact shape.
const EXTRACT_CLASSES_SCHEMA = {
  type: "object",
  properties: {
    classes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          courseCode: { type: "string" },
          courseName: { type: "string" },
          dayName: { type: "string", enum: DAY_NAMES },
          startTime: {
            type: "string",
            description: '24-hour "HH:MM" start time',
          },
          endTime: {
            type: "string",
            description: '24-hour "HH:MM" end time',
          },
          venue: { type: "string" },
        },
        required: [
          "courseCode",
          "courseName",
          "dayName",
          "startTime",
          "endTime",
          "venue",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["classes"],
  additionalProperties: false,
};

function isPdfBuffer(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return false;
  // The spec allows leading junk before the magic bytes; they must appear
  // somewhere in the first 1024 bytes.
  return body.subarray(0, 1024).includes("%PDF-");
}

function fetchGemini(apiKey, model, pdfBase64, signal) {
  return fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            { text: EXTRACT_PROMPT },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: EXTRACT_CLASSES_SCHEMA,
      },
    }),
    signal,
  });
}

function normalizeTime(value) {
  const match = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

// The schema above already pins Gemini's output shape, but a defensive pass
// keeps junk out of the student's calendar no matter what the model returns:
// rows without a usable day/time, or with no name at all, are dropped.
function normalizeClass(raw) {
  if (!raw || typeof raw !== "object") return null;

  const dayName = DAY_NAMES.find(
    (name) =>
      name.toLowerCase() ===
      String(raw.dayName ?? "")
        .trim()
        .toLowerCase(),
  );
  const startTime = normalizeTime(raw.startTime);
  const endTime = normalizeTime(raw.endTime);
  if (!dayName || !startTime || !endTime) return null;

  const courseCode = String(raw.courseCode ?? "").trim();
  const courseName = String(raw.courseName ?? "").trim();
  if (!courseCode && !courseName) return null;

  return {
    courseCode,
    courseName,
    dayName,
    startTime,
    endTime,
    venue: String(raw.venue ?? "").trim(),
  };
}

router.post(
  "/parse",
  express.raw({ type: "application/pdf", limit: MAX_PDF_BYTES }),
  async (req, res) => {
    if (!req.is("application/pdf")) {
      return res.status(400).json({ error: "Uploaded file must be a PDF." });
    }
    if (!isPdfBuffer(req.body)) {
      return res
        .status(400)
        .json({ error: "That file doesn't look like a PDF." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error:
          "Timetable AI parsing is not configured — set GEMINI_API_KEY on the server.",
      });
    }

    const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    const pdfBase64 = req.body.toString("base64");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let response;
    try {
      response = await fetchGemini(apiKey, model, pdfBase64, controller.signal);
      for (const delay of GEMINI_RETRY_DELAYS_MS) {
        if (!TRANSIENT_GEMINI_STATUSES.has(response.status)) break;
        await response.text().catch(() => "");
        await new Promise((resolve) => setTimeout(resolve, delay));
        response = await fetchGemini(
          apiKey,
          model,
          pdfBase64,
          controller.signal,
        );
      }
    } catch (err) {
      console.error("Timetable parse: Gemini request failed:", err);
      return res
        .status(502)
        .json({ error: "Could not reach the AI reader — try again." });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(
        `Timetable parse: Gemini returned ${response.status}:`,
        detail.slice(0, 500),
      );
      return res
        .status(502)
        .json({ error: "The AI reader could not read that PDF — try again." });
    }

    const payload = await response.json().catch(() => null);
    const text = (payload?.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("");

    let extracted = null;
    try {
      extracted = JSON.parse(text);
    } catch {
      extracted = null;
    }

    const classes = Array.isArray(extracted?.classes)
      ? extracted.classes.map(normalizeClass).filter(Boolean)
      : [];
    if (classes.length === 0) {
      return res
        .status(502)
        .json({ error: "Could not find any classes in that PDF." });
    }

    classes.sort(
      (a, b) =>
        DAY_NAMES.indexOf(a.dayName) - DAY_NAMES.indexOf(b.dayName) ||
        a.startTime.localeCompare(b.startTime),
    );

    res.json({ classes });
  },
);

// express.raw rejects oversized uploads with a raw-body error before the route
// above ever runs — answer with the size limit instead of a bare 500.
router.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: `PDF is too large — the limit is ${MAX_PDF_BYTES / 1024 / 1024} MB.`,
    });
  }
  next(err);
});

module.exports = router;
