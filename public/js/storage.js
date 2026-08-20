// Supabase-backed data layer for logged tutoring hours. Every read/write
// goes through the functions below and the /api/hour-entries routes
// (server/routes/), scoped to whichever user is signed in (see
// getCurrentUser).

export function getCurrentUser() {
  const raw = sessionStorage.getItem('user');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fromApiEntry(row) {
  return {
    id: row.id,
    date: row.date,
    hours: Number(row.hours),
    startTime: row.start_time || '',
    endTime: row.end_time || '',
    taskType: row.task_type || 'Tutoring',
    subject: row.subject || '',
    notes: row.notes || '',
  };
}

async function readJson(response, failureMessage) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || failureMessage);
  }
  return response.json();
}

// --- Entries -------------------------------------------------------------

let entriesCache = null;

async function fetchEntries() {
  const user = getCurrentUser();
  if (!user) return [];
  const res = await fetch(`/api/hour-entries?userId=${encodeURIComponent(user.id)}`);
  const data = await readJson(res, 'Failed to load hours');
  return data.map(fromApiEntry);
}

export async function getEntries() {
  if (!entriesCache) entriesCache = await fetchEntries();
  return [...entriesCache].sort((a, b) => a.date.localeCompare(b.date));
}

export async function addEntry(entry) {
  const user = getCurrentUser();
  const res = await fetch('/api/hour-entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: user.id, ...entry }),
  });
  const row = await readJson(res, 'Failed to add entry');
  entriesCache = null;
  return fromApiEntry(row);
}

export async function updateEntry(id, changes) {
  const res = await fetch(`/api/hour-entries/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const row = await readJson(res, 'Failed to update entry');
  entriesCache = null;
  return fromApiEntry(row);
}

export async function deleteEntry(id) {
  const res = await fetch(`/api/hour-entries/${id}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to delete entry');
  }
  entriesCache = null;
}

// Flags an entry with the same date, hours, task type and course code as an
// existing one (ignoring the entry currently being edited, if any).
export async function findDuplicateEntry({ date, hours, taskType, subject }, excludeId = null) {
  const entries = await getEntries();
  return (
    entries.find(
      (e) =>
        e.id !== excludeId &&
        e.date === date &&
        Number(e.hours) === Number(hours) &&
        (e.taskType || 'Tutoring') === (taskType || 'Tutoring') &&
        (e.subject || '') === (subject || '')
    ) || null
  );
}

export async function getEntriesForWeek(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const entries = await getEntries();
  return entries.filter((e) => e.date >= weekStart && e.date <= weekEnd);
}

export async function getWeekTotal(weekStart) {
  const entries = await getEntriesForWeek(weekStart);
  return entries.reduce((sum, e) => sum + Number(e.hours), 0);
}

export async function getEntriesForDate(dateStr) {
  const entries = await getEntries();
  return entries.filter((e) => e.date === dateStr);
}

// --- Date helpers (pure, no network) ----------------------------------

// Monday-based week start for a given 'YYYY-MM-DD' date string.
export function getWeekStart(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return toDateStr(date);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return toDateStr(new Date());
}
