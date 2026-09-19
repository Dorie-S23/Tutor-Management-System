// Supabase-backed data layer for logged tutoring hours. Every read/write
// goes through the functions below and the /api/hour-entries routes
// (server/routes/), scoped to whichever user is signed in (see
// getCurrentUser).

export function getCurrentUser() {
  const raw = sessionStorage.getItem("user");
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
    startTime: row.start_time || "",
    endTime: row.end_time || "",
    taskType: row.task_type || "Tutoring",
    subject: row.subject || "",
    notes: row.notes || "",
    courseId: row.course_id ?? null,
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
  const res = await fetch(
    `/api/hour-entries?userId=${encodeURIComponent(user.id)}`,
  );
  const data = await readJson(res, "Failed to load hours");
  return data.map(fromApiEntry);
}

export async function getEntries() {
  if (!entriesCache) entriesCache = await fetchEntries();
  return [...entriesCache].sort((a, b) => a.date.localeCompare(b.date));
}

export async function addEntry(entry) {
  const user = getCurrentUser();
  const res = await fetch("/api/hour-entries", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user.id, ...entry }),
  });
  const row = await readJson(res, "Failed to add entry");
  entriesCache = null;
  return fromApiEntry(row);
}

export async function updateEntry(id, changes) {
  const res = await fetch(`/api/hour-entries/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(changes),
  });
  const row = await readJson(res, "Failed to update entry");
  entriesCache = null;
  return fromApiEntry(row);
}

export async function deleteEntry(id) {
  const res = await fetch(`/api/hour-entries/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete entry");
  }
  entriesCache = null;
}

// Flags an entry with the same date, hours, task type and course as an
// existing one (ignoring the entry currently being edited, if any).
// Compares by courseId when either entry has one — the free-text subject
// is only used as a fallback for older entries logged before courses were
// linked properly.
export async function findDuplicateEntry(
  { date, hours, taskType, subject, courseId },
  excludeId = null,
) {
  const entries = await getEntries();
  return (
    entries.find((e) => {
      if (e.id === excludeId) return false;
      if (e.date !== date) return false;
      if (Number(e.hours) !== Number(hours)) return false;
      if ((e.taskType || "Tutoring") !== (taskType || "Tutoring")) return false;

      if (courseId != null || e.courseId != null) {
        return (e.courseId ?? null) === (courseId ?? null);
      }
      return (e.subject || "") === (subject || "");
    }) || null
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
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diffToMonday);
  return toDateStr(date);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return toDateStr(new Date());
}

// ---------- tutor profile (used to fill in the printable timesheet) ----------

const PROFILE_KEY = "tutorHours.profile";

export function getProfile() {
  const raw = localStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

// ---------- recurring class schedule (imported from a timetable PDF) ----------
// Each class recurs weekly on the same weekday from firstDate through endDate,
// separate from logged hours so it never affects hours-worked totals.

const SCHEDULE_KEY = "tutorHours.schedule";

function readSchedule() {
  const raw = localStorage.getItem(SCHEDULE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSchedule(classes) {
  localStorage.setItem(SCHEDULE_KEY, JSON.stringify(classes));
}

export function getSchedule() {
  return readSchedule();
}

// Mirrors the local schedule to the server as tutor_busy_times, so the
// organiser board can run live timetable-clash checks. Best-effort: the
// local calendar (source of truth for the tutor's own view) already
// succeeded by the time this runs, so a network failure here shouldn't
// block anything — just log it.
function syncScheduleToServer() {
  const user = getCurrentUser();
  if (!user) return;
  fetch(`/api/tutors/${user.id}/busy-times`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classes: readSchedule() }),
  }).catch((err) => console.warn("Failed to sync schedule to server:", err));
}

export function addScheduleClasses(classes) {
  const now = new Date().toISOString();
  const withIds = classes.map((c) => ({
    id: crypto.randomUUID(),
    createdAt: now,
    ...c,
  }));
  writeSchedule([...readSchedule(), ...withIds]);
  syncScheduleToServer();
  return withIds;
}

export function deleteScheduleClass(id) {
  writeSchedule(readSchedule().filter((c) => c.id !== id));
  writeExceptions(readExceptions().filter((e) => e.classId !== id));
  syncScheduleToServer();
}

export function clearSchedule() {
  writeSchedule([]);
  writeExceptions([]);
  syncScheduleToServer();
}

// ---------- exceptions to the recurring schedule ----------
// A single occurrence of a recurring class can be cancelled (e.g. a public
// holiday) or modified (e.g. moved to a different time/venue for one week)
// without touching the recurrence rule itself. Keyed by (classId, date) so
// there's at most one exception per class per day.

const SCHEDULE_EXCEPTIONS_KEY = "tutorHours.scheduleExceptions";

function readExceptions() {
  const raw = localStorage.getItem(SCHEDULE_EXCEPTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeExceptions(exceptions) {
  localStorage.setItem(SCHEDULE_EXCEPTIONS_KEY, JSON.stringify(exceptions));
}

export function getScheduleExceptions() {
  return readExceptions();
}

// Cancels a single occurrence of a recurring class on the given date.
export function cancelScheduleOccurrence(classId, dateStr) {
  const exceptions = readExceptions().filter(
    (e) => !(e.classId === classId && e.date === dateStr),
  );
  exceptions.push({ classId, date: dateStr, type: "cancelled" });
  writeExceptions(exceptions);
}

// Overrides one or more fields (startTime, endTime, venue, title) for a
// single occurrence, leaving every other occurrence untouched.
export function modifyScheduleOccurrence(classId, dateStr, overrides) {
  const exceptions = readExceptions().filter(
    (e) => !(e.classId === classId && e.date === dateStr),
  );
  exceptions.push({ classId, date: dateStr, type: "modified", overrides });
  writeExceptions(exceptions);
}

// Removes any exception for this occurrence, reverting it back to the
// normal recurring class.
export function clearScheduleException(classId, dateStr) {
  writeExceptions(
    readExceptions().filter(
      (e) => !(e.classId === classId && e.date === dateStr),
    ),
  );
}

// getScheduleForDate hides cancelled occurrences entirely, so the calendar
// UI needs a separate lookup to show *something* clickable in their place
// (otherwise a cancelled class silently vanishes with no way to undo it).
export function getCancelledOccurrencesForDate(dateStr) {
  const exceptions = readExceptions().filter(
    (e) => e.date === dateStr && e.type === "cancelled",
  );
  if (exceptions.length === 0) return [];

  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const classes = readSchedule().filter(
    (c) =>
      c.dayOfWeek === weekday && dateStr >= c.firstDate && dateStr <= c.endDate,
  );

  return exceptions
    .map((e) => classes.find((c) => c.id === e.classId))
    .filter(Boolean);
}

export function getScheduleForDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  const classes = readSchedule().filter(
    (c) =>
      c.dayOfWeek === weekday && dateStr >= c.firstDate && dateStr <= c.endDate,
  );

  const exceptions = readExceptions();
  if (exceptions.length === 0) return classes;

  return classes
    .map((c) => {
      const exception = exceptions.find(
        (e) => e.classId === c.id && e.date === dateStr,
      );
      if (!exception) return c;
      if (exception.type === "cancelled") return null;
      if (exception.type === "modified") {
        return { ...c, ...exception.overrides, isModifiedOccurrence: true };
      }
      return c;
    })
    .filter(Boolean);
}