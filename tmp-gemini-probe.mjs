// Throwaway: send the synthetic timetable PDF to each candidate model using
// the exact request shape the parse route uses. Prints statuses only.
import fs from "node:fs";

const env = fs.readFileSync(".env", "utf8");
const key = env.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
const pdf = fs.readFileSync("tmp-timetable-check.pdf").toString("base64");

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const EXTRACT_PROMPT = `This PDF is a university student's weekly class timetable. Layouts vary between exports — it may be plain text rows, or a colored grid table with day-of-week columns and time-of-day rows. Extract every distinct weekly class session shown.

For each session capture:
- courseCode: the course/module code exactly as printed (e.g. "COMS3011A"), or an empty string if the timetable only shows a name.
- courseName: the course/class name as printed (e.g. "Software Design Project III", or "AA Tutorial" when only a class-type label is shown), or an empty string if only a code is shown.
- dayName: the full day of the week it occurs on.
- startTime / endTime: 24-hour "HH:MM" times — convert anything like "10h15" or "2 PM" into that format.
- venue: the room/venue label exactly as printed (e.g. "MSL004"), or an empty string if the timetable doesn't state one. If the identical class appears in multiple venues at the exact same day and time (parallel sections), merge them into one entry with venues joined by "/".

Ignore non-class rows such as "BREAK" labels, empty cells, and the day/time headers themselves. This timetable is a weekly template with no real calendar dates attached — do not invent or guess a date. Never invent a course code, name, or venue that isn't printed in the PDF.`;
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
          startTime: { type: "string" },
          endTime: { type: "string" },
          venue: { type: "string" },
        },
        required: ["courseCode", "courseName", "dayName", "startTime", "endTime", "venue"],
        additionalProperties: false,
      },
    },
  },
  required: ["classes"],
  additionalProperties: false,
};

for (const m of ["gemini-3-flash-preview"]) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "application/pdf", data: pdf } },
                { text: EXTRACT_PROMPT },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: EXTRACT_CLASSES_SCHEMA,
          },
        }),
      },
    );
    const body = await res.text();
    console.log(`--- ${m}: HTTP ${res.status}`);
    console.log(body.slice(0, 400).replace(/\s+/g, " "));
    if (res.status === 200) break;
  } catch (err) {
    console.log(`--- ${m}: fetch failed — ${err.message}`);
  }
}
