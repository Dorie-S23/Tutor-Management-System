/* ============================================================
   Shared sample data + localStorage-backed state for the student
   volunteer pages (Dashboard, My Sessions). Swapping this file's
   internals for real API calls is the on-ramp to Supabase later.
   ============================================================ */

const OPEN_SESSIONS = [
  {
    id: "o1", emoji: "📐", subject: "Mathematics", topic: "Algebra basics",
    day: "Mon", time: "14:00–15:00",
    student: "Keitumetse", note: "Struggling with linear equations",
  },
  {
    id: "o2", emoji: "🔬", subject: "Science", topic: "Physics – forces",
    day: "Wed", time: "11:00–12:00",
    student: "Bongani", note: "Wants to review before Friday's test",
  },
  {
    id: "o3", emoji: "📖", subject: "English", topic: "Essay structure",
    day: "Thu", time: "16:00–17:00",
    student: "Lindiwe", note: "",
  },
  {
    id: "o4", emoji: "💻", subject: "Computer Science", topic: "Intro to loops",
    day: "Fri", time: "13:00–14:00",
    student: "Tumi", note: "First time programming",
  },
];

const SEED_UPCOMING = [
  { id: "u1", subject: "Math Tutoring", withWho: "Jordan", when: "Today, 4:00 PM" },
  { id: "u2", subject: "Science Help", withWho: "Sam", when: "Tomorrow, 3:30 PM" },
];

const PAST_SESSIONS = [
  { id: "p1", subject: "Math Tutoring", withWho: "Ayanda", when: "Last Mon, 2:00 PM", status: "Completed" },
  { id: "p2", subject: "English Help", withWho: "Naledi", when: "Last Wed, 10:00 AM", status: "Completed" },
  { id: "p3", subject: "Computer Science Tutoring", withWho: "Karabo", when: "2 weeks ago", status: "Missed" },
];

const CLAIMED_KEY = "studentVolunteer.claimedSessionIds";
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

function removeId(key, id) {
  writeIds(key, readIds(key).filter((existing) => existing !== id));
}

function getOpenSessions() {
  const claimed = readIds(CLAIMED_KEY);
  return OPEN_SESSIONS.filter((s) => !claimed.includes(s.id));
}

function getUpcomingSessions() {
  const claimed = readIds(CLAIMED_KEY);
  const cancelledSeed = readIds(CANCELLED_SEED_KEY);

  const claimedAsUpcoming = OPEN_SESSIONS
    .filter((s) => claimed.includes(s.id))
    .map((s) => ({
      id: s.id,
      subject: `${s.subject} Tutoring`,
      withWho: s.student,
      when: `${s.day}, ${s.time}`,
    }));

  const seed = SEED_UPCOMING.filter((s) => !cancelledSeed.includes(s.id));

  return [...seed, ...claimedAsUpcoming];
}

function getPastSessions() {
  return PAST_SESSIONS;
}

function claimSession(sessionId) {
  addId(CLAIMED_KEY, sessionId);
}

// Cancelling a claimed open-session frees the slot back to Open Sessions;
// cancelling a seed/confirmed session just drops it from Upcoming.
function cancelUpcomingSession(sessionId) {
  if (OPEN_SESSIONS.some((s) => s.id === sessionId)) {
    removeId(CLAIMED_KEY, sessionId);
  } else {
    addId(CANCELLED_SEED_KEY, sessionId);
  }
}

window.StudentData = {
  getOpenSessions,
  getUpcomingSessions,
  getPastSessions,
  claimSession,
  cancelUpcomingSession,
};
