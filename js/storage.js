// localStorage-backed data layer for logged tutoring hours.
// Every read/write to persisted data goes through the functions below, so
// swapping localStorage for real API calls later only means editing this file.

const STORAGE_KEY = 'tutorHours.entries';

function readAll() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function getEntries() {
  return readAll().sort((a, b) => a.date.localeCompare(b.date));
}

export function getEntriesForDate(dateStr) {
  return readAll().filter((e) => e.date === dateStr);
}

export function addEntry({ date, hours, subject, taskType, supervisorName, startTime, endTime, notes }) {
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    date,
    hours,
    subject: subject || '',
    taskType: taskType || '',
    supervisorName: supervisorName || '',
    startTime: startTime || '',
    endTime: endTime || '',
    notes: notes || '',
    createdAt: now,
    updatedAt: now,
  };
  const entries = readAll();
  entries.push(entry);
  writeAll(entries);
  return entry;
}

export function updateEntry(id, changes) {
  const entries = readAll();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) return null;
  entries[index] = { ...entries[index], ...changes, updatedAt: new Date().toISOString() };
  writeAll(entries);
  return entries[index];
}

export function deleteEntry(id) {
  const entries = readAll().filter((e) => e.id !== id);
  writeAll(entries);
}

// Finds an existing entry with the same date, hours, subject and task type
// (case-insensitive), so the UI can block accidental duplicate logging.
// Pass excludeId when checking an in-progress edit so it doesn't match itself.
export function findDuplicateEntry({ date, hours, subject, taskType }, excludeId = null) {
  const normalizedSubject = (subject || '').trim().toLowerCase();
  const normalizedTaskType = (taskType || '').trim().toLowerCase();

  return (
    readAll().find((e) => {
      if (e.id === excludeId) return false;
      return (
        e.date === date &&
        Number(e.hours) === Number(hours) &&
        (e.subject || '').trim().toLowerCase() === normalizedSubject &&
        (e.taskType || '').trim().toLowerCase() === normalizedTaskType
      );
    }) || null
  );
}

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

export function getEntriesForWeek(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  return getEntries().filter((e) => e.date >= weekStart && e.date <= weekEnd);
}

export function getWeekTotal(weekStart) {
  return getEntriesForWeek(weekStart).reduce((sum, e) => sum + Number(e.hours), 0);
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

// ---------- tutor profile (used to fill in the printable timesheet) ----------

const PROFILE_KEY = 'tutorHours.profile';

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
