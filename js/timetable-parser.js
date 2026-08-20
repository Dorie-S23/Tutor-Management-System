// Timetable PDFs are parsed server-side by an LLM (see server/timetableRoutes.js),
// which handles arbitrary layouts instead of a format-specific regex parser.
// The PDF never has real calendar dates attached to its weekly grid, so this
// module computes each class's first occurrence from a user-chosen start date.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// The next date on/after startDateStr ("YYYY-MM-DD") that falls on dayOfWeek (0-6).
export function firstOccurrenceOnOrAfter(startDateStr, dayOfWeek) {
  const [y, m, d] = startDateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const diff = (dayOfWeek - start.getDay() + 7) % 7;
  start.setDate(start.getDate() + diff);
  return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

export async function parseTimetableViaApi(file) {
  const formData = new FormData();
  formData.append('file', file);

  let response;
  try {
    response = await fetch('/api/timetable/parse', { method: 'POST', body: formData });
  } catch {
    throw new Error('Could not reach the server — make sure it’s running (npm start).');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Could not read that PDF.');
  }

  const { classes } = await response.json();
  if (!Array.isArray(classes)) {
    throw new Error('Unexpected response from the server.');
  }

  return classes.map((cls) => ({
    title: cls.title,
    dayName: cls.dayName,
    dayOfWeek: DAY_NAMES.indexOf(cls.dayName),
    startTime: cls.startTime,
    endTime: cls.endTime,
    venue: cls.venue,
  }));
}

// Fallback for PDFs the LLM can't make sense of either: accepts a pasted JSON
// array of classes and normalizes it into the same shape parseTimetableViaApi() produces.
export function parseTimetableJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('That doesn’t look like valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Expected a JSON array of classes.');
  }

  return parsed.map((item, i) => {
    const dayOfWeek = DAY_NAMES.indexOf(item.dayName);
    if (dayOfWeek === -1) {
      throw new Error(`Row ${i + 1}: "${item.dayName}" isn’t a recognised day name.`);
    }
    if (!item.title || !item.firstDate || !item.startTime || !item.endTime) {
      throw new Error(`Row ${i + 1} is missing a required field (title, firstDate, startTime or endTime).`);
    }
    return {
      title: item.title,
      dayName: item.dayName,
      dayOfWeek,
      firstDate: item.firstDate,
      startTime: item.startTime,
      endTime: item.endTime,
      venue: item.venue || '',
    };
  });
}
