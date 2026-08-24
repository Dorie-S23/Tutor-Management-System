/* ============================================================
   Shared sample data + localStorage-backed state for the student
   volunteer pages (Dashboard, My Sessions). Swapping this file's
   internals for real API calls is the on-ramp to Supabase later.
   ============================================================ */

const SEED_UPCOMING = [
  { id: "u1", subject: "Math Tutoring", withWho: "Jordan", when: "Today, 4:00 PM" },
  { id: "u2", subject: "Science Help", withWho: "Sam", when: "Tomorrow, 3:30 PM" },
];

const CANCELLED_SEED_KEY = "studentVolunteer.cancelledSeedIds";

function readIds(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIds(key, ids) {
  localStorage.setItem(key, JSON.stringify(ids));
}

function addId(key, id) {
  const ids = readIds(key);
  if (!ids.includes(id)) {
    ids.push(id);
    writeIds(key, ids);
  }
}

function getUpcomingSessions() {
  const cancelledSeed = readIds(CANCELLED_SEED_KEY);
  return SEED_UPCOMING.filter((s) => !cancelledSeed.includes(s.id));
}

function cancelUpcomingSession(sessionId) {
  addId(CANCELLED_SEED_KEY, sessionId);
}

window.StudentData = {
  getUpcomingSessions,
  cancelUpcomingSession,
};
