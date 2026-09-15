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

// Where each role lands after login (mirrors the switch in auth.js).
const ROLE_HOME = {
  student: "StudentView.html",
  tutor: "dashboard.html",
  organiser: "board.html",
};

// Guards a role-specific page: sends a signed-out visitor to login, and
// sends a signed-in visitor of the *wrong* role back to their own home page
// instead of letting them view (and act on) a page built for another role.
// Call this at the top of a page's script, before anything else runs.
export function requireRole(allowedRole) {
  const user = getCurrentUser();
  if (!user) {
    window.location.href = "login.html";
    return null;
  }
  if (user.role !== allowedRole) {
    window.location.href = ROLE_HOME[user.role] || "login.html";
    return null;
  }
  return user;
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

// Flags an entry whose time range overlaps another one's on the same date —
// nobody can be doing two different things (even a different task type or
// course) at the same moment, so this ignores every other field on purpose.
// "HH:MM" strings compare correctly as plain strings since they're
// zero-padded, so no need to parse them into minutes. Two ranges overlap
// when each one starts before the other ends; entries that are merely
// back-to-back (one starts exactly when the other ends) don't count — e.g.
// 10:00-12:00 and 12:00-13:00 coexist fine, but 11:30-13:03 overlaps both
// (ignoring the entry currently being edited, if any).
export async function findDuplicateEntry(
  { date, startTime, endTime },
  excludeId = null,
) {
  if (!startTime || !endTime) return null;
  const entries = await getEntries();
  return (
    entries.find(
      (e) =>
        e.id !== excludeId &&
        e.date === date &&
        e.startTime &&
        e.endTime &&
        startTime < e.endTime &&
        e.startTime < endTime,
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

// Namespaced by user id — a fixed key would leak one signed-in user's data
// to whoever is signed in next on the same browser (localStorage is shared
// across the whole origin, not per-session like sessionStorage).
function profileKey() {
  const user = getCurrentUser();
  return `tutorHours.profile.${user ? user.id : "anon"}`;
}

export function getProfile() {
  const raw = localStorage.getItem(profileKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  localStorage.setItem(profileKey(), JSON.stringify(profile));
}

// ---------- recurring class schedule (imported from a timetable PDF) ----------
// Each class recurs weekly on the same weekday from firstDate through endDate,
// separate from logged hours so it never affects hours-worked totals.

// Namespaced by user id for the same reason as profileKey() above — without
// this, a tutor's added/imported classes show up on whichever account is
// signed in next on the same browser (this is what caused a volunteer to
// see a different tutor's course sessions on their calendar).
function scheduleKey() {
  const user = getCurrentUser();
  return `tutorHours.schedule.${user ? user.id : "anon"}`;
}

function readSchedule() {
  const raw = localStorage.getItem(scheduleKey());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSchedule(classes) {
  localStorage.setItem(scheduleKey(), JSON.stringify(classes));
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

// Updates the base fields of a recurring class (title, dayOfWeek, startTime,
// endTime, venue, firstDate, endDate). Affects every future occurrence that
// hasn't been individually overridden.
export function updateScheduleClass(id, changes) {
  const schedule = readSchedule().map((c) =>
    c.id === id ? { ...c, ...changes } : c,
  );
  writeSchedule(schedule);
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

function scheduleExceptionsKey() {
  const user = getCurrentUser();
  return `tutorHours.scheduleExceptions.${user ? user.id : "anon"}`;
}

function readExceptions() {
  const raw = localStorage.getItem(scheduleExceptionsKey());
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeExceptions(exceptions) {
  localStorage.setItem(scheduleExceptionsKey(), JSON.stringify(exceptions));
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
