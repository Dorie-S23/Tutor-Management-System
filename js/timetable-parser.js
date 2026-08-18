// Parses a Wits "My Class Schedule" PDF export (the self-service weekly
// timetable grid) into a list of class blocks. Text extraction flattens the
// visual grid, so this reconstructs it: day columns from the weekday header
// x-positions, then top-to-bottom lines within each column, segmented into
// blocks at each "COURSE CODE - X Type" line.
//
// A single class taught in parallel across several venues at the same time
// prints as repeated identical blocks (one per venue) inside the same day
// column — these are merged into one entry with venues joined by "/".
//
// This is tuned to that specific export format, not PDF timetables in
// general — callers should always let the user review/edit the result
// before saving it.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

// Matches a whole class block's leading label, e.g. "MATH 2016A - E Lecture",
// stopping right before the time range (or end of string) that follows it.
// Scanned across each day column's *joined* text rather than per text-item,
// since PDF exports vary in whether a cell's text comes back from pdf.js as
// one item per line or the whole cell bundled into a single item.
const BLOCK_START_GLOBAL_RE = /[A-Z]{2,6}\s?\d{3,4}[A-Z]?\s*-\s*[A-Z]\s+.+?(?=\s+\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}|$)/g;
const TIME_RANGE_RE = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;
const VENUE_RE = /SYLLABUS\s+PLUS\s+VENUES\s+(\S+)/i;
// No \b after the day name: some PDF exports (e.g. browser print-to-PDF) can
// butt the following date straight up against it with no separating space.
const DAY_RE = new RegExp(`^(${DAY_NAMES.join('|')})`);

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function loadPdfJs() {
  const pdfjsLib = await import('https://unpkg.com/pdfjs-dist@4/build/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4/build/pdf.worker.min.mjs';
  return pdfjsLib;
}

function extractYear(items) {
  for (const it of items) {
    const m = it.str.match(/\b(20\d{2})\b/);
    if (m) return Number(m[1]);
  }
  return new Date().getFullYear();
}

// Finds a "10 Aug" style date token anywhere inside a string, not just when
// the whole string is exactly that — some exports bundle it with other text.
function findDateToken(str) {
  const m = str.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return null;
  const monthName = Object.keys(MONTHS).find((name) => name.startsWith(m[2]));
  if (!monthName) return null;
  return { day: Number(m[1]), month: MONTHS[monthName] };
}

// Fallback for PDFs with no text layer (e.g. image/scanned exports), where
// pdf.js has nothing to extract. Accepts a pasted JSON array of classes and
// normalizes it into the same shape parseTimetablePdf() produces, so it can
// feed the same review UI.
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

export async function parseTimetablePdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();

  const items = content.items
    .map((it) => ({ str: it.str.replace(/\s+/g, ' ').trim(), x: it.transform[4], y: it.transform[5] }))
    .filter((it) => it.str.length > 0);

  if (items.length === 0) {
    throw new Error(
      'This PDF has no extractable text at all — it’s likely an image/scanned page rather than a real text export, so automatic parsing can’t work on it. Use "paste timetable data" below instead.'
    );
  }

  const year = extractYear(items);

  const dayHeaders = items.filter((it) => DAY_RE.test(it.str));
  if (dayHeaders.length === 0) {
    const err = new Error('Could not find day-of-week column headers — this may not be a Wits class schedule export.');
    err.debugItems = items;
    throw err;
  }

  const dateNearHeader = (header) => {
    const candidates = items.filter(
      (it) => it !== header && Math.abs(it.x - header.x) < 25 && it.y < header.y && findDateToken(it.str)
    );
    candidates.sort((a, b) => b.y - a.y);
    return candidates[0];
  };

  const columns = dayHeaders
    .map((header) => {
      const dayName = header.str.match(DAY_RE)[1];
      const dateToken = findDateToken(header.str) || (dateNearHeader(header) && findDateToken(dateNearHeader(header).str));
      if (!dateToken) return null;
      return {
        dayName,
        dayOfWeek: DAY_NAMES.indexOf(dayName),
        x: header.x,
        date: `${year}-${pad2(dateToken.month)}-${pad2(dateToken.day)}`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);

  if (columns.length === 0) {
    const err = new Error('Found day headers but could not read the dates under them.');
    err.debugItems = items;
    throw err;
  }

  const boundaries = columns.map((c, i) =>
    i === columns.length - 1 ? Infinity : (c.x + columns[i + 1].x) / 2
  );
  function columnForX(x) {
    for (let i = 0; i < columns.length; i++) {
      if (x < boundaries[i]) return columns[i];
    }
    return columns[columns.length - 1];
  }

  const headerY = Math.min(...dayHeaders.map((h) => h.y));
  const bodyItems = items.filter((it) => it.y < headerY - 5 && it.x >= columns[0].x - 40);

  const byColumn = new Map(columns.map((c) => [c.dayName, []]));
  for (const it of bodyItems) {
    byColumn.get(columnForX(it.x).dayName).push(it);
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => b.y - a.y); // top of page first
  }

  const rawBlocks = [];
  for (const col of columns) {
    const text = byColumn.get(col.dayName).map((it) => it.str).join(' ');
    const starts = [...text.matchAll(BLOCK_START_GLOBAL_RE)];

    for (let i = 0; i < starts.length; i++) {
      const match = starts[i];
      const blockEnd = i + 1 < starts.length ? starts[i + 1].index : text.length;
      const blockText = text.slice(match.index, blockEnd);

      const timeMatch = blockText.match(TIME_RANGE_RE);
      const venueMatch = blockText.match(VENUE_RE);
      if (!timeMatch || !venueMatch) continue;

      rawBlocks.push({
        day: col,
        title: match[0].trim(),
        time: { start: timeMatch[1], end: timeMatch[2] },
        venue: venueMatch[1],
      });
    }
  }

  const merged = [];
  for (const block of rawBlocks) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.day.dayName === block.day.dayName &&
      last.title === block.title &&
      last.time.start === block.time.start &&
      last.time.end === block.time.end
    ) {
      if (!last.venues.includes(block.venue)) last.venues.push(block.venue);
    } else {
      merged.push({ ...block, venues: [block.venue] });
    }
  }

  return merged.map((b) => ({
    title: b.title,
    dayName: b.day.dayName,
    dayOfWeek: b.day.dayOfWeek,
    firstDate: b.day.date,
    startTime: b.time.start,
    endTime: b.time.end,
    venue: b.venues.join('/'),
  }));
}