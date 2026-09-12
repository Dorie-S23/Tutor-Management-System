const express = require("express");
const multer = require("multer");
const gemini = require("./geminiClient");

const router = express.Router();

// Base64 inflates the raw file by ~33%; keep comfortably under the API's 32MB request limit.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const EXTRACT_PROMPT = `This PDF is a university student's weekly class timetable. Layouts vary between exports — it may be plain text rows, or a colored grid table with day-of-week columns and time-of-day rows. Extract every distinct weekly class session shown.

For each session capture:
- title: the course code plus any class type (e.g. "COMS3011A - SDP Lecture", "MATH2016A - AA Tutorial"). Keep it recognisable but concise.
- dayName: the day of the week it occurs on.
- startTime / endTime: 24-hour "HH:MM" times.
- venue: the room/venue. If the identical class appears in multiple venues at the exact same day and time (parallel sections), merge them into one entry with venues joined by "/".

Ignore non-class rows such as "BREAK" labels, empty cells, and the day/time headers themselves. This timetable is a weekly template with no real calendar dates attached to it — do not invent or guess a date.`;

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
          title: { type: "string" },
          dayName: {
            type: "string",
            enum: [
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ],
          },
          startTime: { type: "string" },
          endTime: { type: "string" },
          venue: { type: "string" },
        },
        required: ["title", "dayName", "startTime", "endTime", "venue"],
        additionalProperties: false,
      },
    },
  },
  required: ["classes"],
  additionalProperties: false,
};

router.post("/timetable/parse", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No PDF file uploaded." });
  }
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "Uploaded file must be a PDF." });
  }

  try {
    const response = await gemini.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "application/pdf",
                data: req.file.buffer.toString("base64"),
              },
            },
            { text: EXTRACT_PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: EXTRACT_CLASSES_SCHEMA,
      },
    });

    let parsed;
    try {
      parsed = JSON.parse(response.text ?? "");
    } catch {
      parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.classes)) {
      return res
        .status(502)
        .json({ error: "Could not extract classes from that PDF." });
    }

    res.json({ classes: parsed.classes });
  } catch (err) {
    console.error("Timetable parse failed:", err);
    res.status(500).json({ error: "Failed to parse timetable PDF." });
  }
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
