// Read-only view onto scheduled tutoring sessions, stored under the same
// localStorage key the future scheduling feature will write to.

const SESSIONS_KEY = 'tutorHours.sessions';

export function getSessions() {
  const raw = localStorage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getSessionsForDate(dateStr) {
  return getSessions().filter((s) => s.date === dateStr);
}
