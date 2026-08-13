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

export function addEntry({ date, hours, startTime, endTime, taskType, subject, notes }) {
  const now = new Date().toISOString();
  const entry = {
    id: crypto.randomUUID(),
    date,
    hours,
    startTime: startTime || '',
    endTime: endTime || '',
    taskType: taskType || 'Tutoring',
    subject: subject || '',
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

// Flags an entry with the same date, hours, task type and course code as an
// existing one (ignoring the entry currently being edited, if any).
export function findDuplicateEntry({ date, hours, taskType, subject }, excludeId = null) {
  return readAll().find(
    (e) =>
      e.id !== excludeId &&
      e.date === date &&
      Number(e.hours) === Number(hours) &&
      (e.taskType || 'Tutoring') === (taskType || 'Tutoring') &&
      (e.subject || '') === (subject || '')
  ) || null;
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

export function getEntriesForDate(dateStr) {
  return getEntries().filter((e) => e.date === dateStr);
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
