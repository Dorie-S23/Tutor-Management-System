const supabase = require("../supabaseClient");
const { DAY_NAMES } = require("../dayNames");
const { notify } = require("./notificationHelpers");

// When a tutor excuses themselves from a session, an approved student
// volunteer on the same course is automatically put in to cover it. The
// cover lives on the excusal row itself (session_excusals.cover_user_id);
// this module picks who, tells everyone involved, and sends the day-before
// reminder.

// The schedule fields needed to work out when/where a session is.
const COURSE_SCHEDULE =
  "course_code, course_name, Day_of_tut, tutor_start_time, tutor_end_time, venues, Day_of_lab, lab_start_time, lab_end_time, lab_venues";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
}

// One of a course's two weekly sessions, or null if it isn't scheduled.
function sessionOf(course, type) {
  const fields =
    type === "lab"
      ? [
          course?.Day_of_lab,
          course?.lab_start_time,
          course?.lab_end_time,
          course?.lab_venues,
        ]
      : [
          course?.Day_of_tut,
          course?.tutor_start_time,
          course?.tutor_end_time,
          course?.venues,
        ];
  const [day, start, end, venue] = fields;
  if (!day || !start || !end) return null;
  return {
    type,
    label: type === "lab" ? "Lab" : "Tutorial",
    day,
    start: start.slice(0, 5),
    end: end.slice(0, 5),
    venue: venue || "",
  };
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// "COMS4033 Lab on Thu 1 Oct, 12:30–13:15 (MSL004)"
function describeSession(course, session, dateStr) {
  const when = new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const code = course?.course_code || "a course";
  if (!session) return `${code} on ${when}`;
  return `${code} ${session.label} on ${when}, ${session.start}–${session.end}${session.venue ? ` (${session.venue})` : ""}`;
}

// session_excusals has two foreign keys to users (the cover, and the
// volunteer they've asked to take over), so each embed names its column.
const EXCUSAL_SELECT = `*, courses(${COURSE_SCHEDULE}), tutors(name), cover:users!cover_user_id(name), swap_to:users!swap_to_user_id(name)`;

async function loadExcusal(excusalId) {
  const { data, error } = await supabase
    .from("session_excusals")
    .select(EXCUSAL_SELECT)
    .eq("id", excusalId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Every approved volunteer who could cover this excusal, best-placed first.
// Skips anyone excluded or who already declined it, and anyone with a clash
// at that time — another cover that day, or their own session on a
// different course. Of who's left: someone in the excused tutor's diagonal
// first (they already know that group), then whoever has the fewest
// upcoming covers (spread the load), then whoever volunteered earliest.
async function eligibleCovers(excusal, excludeUserIds = []) {
  const course = excusal.courses;
  const session = sessionOf(course, excusal.session_type);
  const excluded = new Set([
    ...excludeUserIds,
    ...(excusal.cover_declined_by || []),
  ]);

  const { data: volunteers, error: volunteersError } = await supabase
    .from("course_volunteers")
    .select("id, user_id, diagonal, created_at, users(name)")
    .eq("course_id", excusal.course_id)
    .eq("status", "approved");
  if (volunteersError) throw volunteersError;

  let candidates = (volunteers || []).filter((v) => !excluded.has(v.user_id));
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((v) => v.user_id);

  const [coversResult, otherCoursesResult, tutorResult] = await Promise.all([
    supabase
      .from("session_excusals")
      .select(
        `id, course_id, session_type, session_date, cover_user_id, courses(${COURSE_SCHEDULE})`,
      )
      .in("cover_user_id", candidateIds)
      .gte("session_date", todayStr()),
    supabase
      .from("course_volunteers")
      .select(`user_id, course_id, courses(${COURSE_SCHEDULE})`)
      .in("user_id", candidateIds)
      .eq("status", "approved"),
    supabase
      .from("tutor_subject_preference")
      .select("diagonal")
      .eq("tutor_id", excusal.tutor_id)
      .eq("course_id", excusal.course_id)
      .maybeSingle(),
  ]);
  if (coversResult.error) throw coversResult.error;
  if (otherCoursesResult.error) throw otherCoursesResult.error;

  const covers = (coversResult.data || []).filter((c) => c.id !== excusal.id);
  const weekday = weekdayOf(excusal.session_date);

  function clashes(userId) {
    if (!session) return false;
    const coverClash = covers.some((c) => {
      if (c.cover_user_id !== userId) return false;
      if (c.session_date !== excusal.session_date) return false;
      const other = sessionOf(c.courses, c.session_type);
      return other && overlaps(session, other);
    });
    if (coverClash) return true;

    return (otherCoursesResult.data || []).some((row) => {
      if (row.user_id !== userId || row.course_id === excusal.course_id) {
        return false;
      }
      return ["tutorial", "lab"].some((type) => {
        const other = sessionOf(row.courses, type);
        return other && other.day === weekday && overlaps(session, other);
      });
    });
  }

  candidates = candidates.filter((v) => !clashes(v.user_id));
  if (candidates.length === 0) return [];

  const upcomingCovers = {};
  covers.forEach((c) => {
    upcomingCovers[c.cover_user_id] =
      (upcomingCovers[c.cover_user_id] || 0) + 1;
  });
  const tutorDiagonal = tutorResult.data?.diagonal || null;

  candidates.sort((a, b) => {
    const aSame = tutorDiagonal && a.diagonal === tutorDiagonal ? 0 : 1;
    const bSame = tutorDiagonal && b.diagonal === tutorDiagonal ? 0 : 1;
    return (
      aSame - bSame ||
      (upcomingCovers[a.user_id] || 0) - (upcomingCovers[b.user_id] || 0) ||
      String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
      (a.users?.name || "").localeCompare(b.users?.name || "")
    );
  });

  return candidates;
}

// The approved volunteer best placed to cover this excusal, or null.
async function pickCover(excusal, excludeUserIds = []) {
  const candidates = await eligibleCovers(excusal, excludeUserIds);
  return candidates[0] || null;
}

// Fire-and-forget notification — a failed ping never undoes the cover.
function safeNotify(userId, payload) {
  if (!userId) return;
  notify(userId, payload).catch((err) =>
    console.warn(`Failed to send ${payload.type} notification:`, err),
  );
}

// Tells a volunteer they're no longer covering a session.
function notifyCoverReleased(excusal, userId, why) {
  const session = sessionOf(excusal.courses, excusal.session_type);
  safeNotify(userId, {
    type: "cover_cancelled",
    message: `You're no longer covering ${describeSession(excusal.courses, session, excusal.session_date)} — ${why}.`,
    relatedEntity: "session_excusal",
    relatedId: excusal.id,
  });
}

// (Re)assigns a cover for one excusal and notifies the volunteer and the
// tutor. `excludeUserIds` keeps specific volunteers out of the running
// (e.g. whoever is being replaced). Returns the updated excusal row.
async function assignCover(excusalId, { excludeUserIds = [] } = {}) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return null;
  if (excusal.session_date < todayStr()) return excusal;

  const chosen = await pickCover(excusal, excludeUserIds);
  const session = sessionOf(excusal.courses, excusal.session_type);
  const described = describeSession(
    excusal.courses,
    session,
    excusal.session_date,
  );

  // A session today or tomorrow is already "reminder-close", so the
  // assignment message doubles as the reminder instead of sending two.
  const soon = excusal.session_date <= addDays(todayStr(), 1);
  const now = new Date().toISOString();

  const { data: updated, error } = await supabase
    .from("session_excusals")
    .update({
      cover_user_id: chosen ? chosen.user_id : null,
      cover_assigned_at: chosen ? now : null,
      cover_reminded_at: chosen && soon ? now : null,
      swap_to_user_id: null,
      swap_requested_at: null,
    })
    .eq("id", excusal.id)
    .select(EXCUSAL_SELECT)
    .single();
  if (error) throw error;

  const tutorName = excusal.tutors?.name || "the tutor";
  if (chosen) {
    const volunteerName = chosen.users?.name || "A volunteer";
    safeNotify(chosen.user_id, {
      type: "cover_assigned",
      message: `You've been assigned to cover ${described} for ${tutorName}.${soon ? "" : " We'll remind you the day before."}`,
      relatedEntity: "session_excusal",
      relatedId: excusal.id,
    });
    safeNotify(excusal.tutor_id, {
      type: "cover_found",
      message: `${volunteerName} will cover your ${described}.`,
      relatedEntity: "session_excusal",
      relatedId: excusal.id,
    });
  } else {
    safeNotify(excusal.tutor_id, {
      type: "cover_unavailable",
      message: `No volunteer is free to cover your ${described} yet — the organiser has been flagged.`,
      relatedEntity: "session_excusal",
      relatedId: excusal.id,
    });
  }

  return updated;
}

// A volunteer who can't make a cover hands it to the next one in line.
async function declineCover(excusalId, userId) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return { error: "not_found" };
  if (excusal.cover_user_id !== userId) return { error: "not_cover" };

  const declined = [...new Set([...(excusal.cover_declined_by || []), userId])];
  const { error } = await supabase
    .from("session_excusals")
    .update({ cover_declined_by: declined })
    .eq("id", excusalId);
  if (error) throw error;

  return { excusal: await assignCover(excusalId) };
}

// ---------- volunteer-to-volunteer swaps ----------
// The covering volunteer can't make it and asks a specific other volunteer
// to take over. Nothing changes until that volunteer accepts — the
// requester stays the cover in the meantime, so the session is never left
// without anyone.

function swapError(code, message) {
  return { error: code, message };
}

async function nameOf(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from("users")
    .select("name")
    .eq("id", userId)
    .maybeSingle();
  return data?.name || null;
}

// Who the current cover could hand this session to: every other eligible
// volunteer (approved on the course, free at that time).
async function swapCandidates(excusalId, userId) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return swapError("not_found", "Excusal not found");
  if (excusal.cover_user_id !== userId) {
    return swapError("forbidden", "You're not the one covering that session");
  }
  const candidates = await eligibleCovers(excusal, [userId]);
  return {
    candidates: candidates.map((v) => ({
      user_id: v.user_id,
      name: v.users?.name || "Unknown",
    })),
  };
}

async function requestSwap(excusalId, userId, toUserId) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return swapError("not_found", "Excusal not found");
  if (excusal.cover_user_id !== userId) {
    return swapError("forbidden", "You're not the one covering that session");
  }
  if (excusal.session_date < todayStr()) {
    return swapError("conflict", "That session has already happened");
  }

  const candidates = await eligibleCovers(excusal, [userId]);
  if (!candidates.some((v) => v.user_id === toUserId)) {
    return swapError(
      "conflict",
      "That volunteer can't take this session — they're not approved on the course or aren't free then",
    );
  }

  const { error } = await supabase
    .from("session_excusals")
    .update({
      swap_to_user_id: toUserId,
      swap_requested_at: new Date().toISOString(),
    })
    .eq("id", excusal.id);
  if (error) throw error;

  const session = sessionOf(excusal.courses, excusal.session_type);
  const requesterName = (await nameOf(userId)) || "Another volunteer";
  safeNotify(toUserId, {
    type: "swap_request",
    message: `${requesterName} can't make ${describeSession(excusal.courses, session, excusal.session_date)} and asked you to take it over. Accept or decline on your dashboard.`,
    relatedEntity: "session_excusal",
    relatedId: excusal.id,
  });

  return { excusal: await loadExcusal(excusal.id) };
}

// The requester takes back a swap request that hasn't been answered yet.
async function withdrawSwap(excusalId, userId) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return swapError("not_found", "Excusal not found");
  if (excusal.cover_user_id !== userId || !excusal.swap_to_user_id) {
    return swapError(
      "conflict",
      "There's no swap request of yours to withdraw",
    );
  }

  const { error } = await supabase
    .from("session_excusals")
    .update({ swap_to_user_id: null, swap_requested_at: null })
    .eq("id", excusal.id);
  if (error) throw error;

  const session = sessionOf(excusal.courses, excusal.session_type);
  safeNotify(excusal.swap_to_user_id, {
    type: "swap_withdrawn",
    message: `The request to take over ${describeSession(excusal.courses, session, excusal.session_date)} was withdrawn — nothing for you to do.`,
    relatedEntity: "session_excusal",
    relatedId: excusal.id,
  });
  return { excusal: await loadExcusal(excusal.id) };
}

// The asked volunteer accepts (and becomes the cover) or declines (and the
// requester keeps it).
async function respondToSwap(excusalId, userId, accept) {
  const excusal = await loadExcusal(excusalId);
  if (!excusal) return swapError("not_found", "Excusal not found");
  if (excusal.swap_to_user_id !== userId) {
    return swapError(
      "forbidden",
      "There's no swap request for you on that session",
    );
  }

  const requesterId = excusal.cover_user_id;
  const session = sessionOf(excusal.courses, excusal.session_type);
  const described = describeSession(
    excusal.courses,
    session,
    excusal.session_date,
  );
  const responderName = (await nameOf(userId)) || "The volunteer you asked";

  if (!accept) {
    const { error } = await supabase
      .from("session_excusals")
      .update({ swap_to_user_id: null, swap_requested_at: null })
      .eq("id", excusal.id);
    if (error) throw error;

    safeNotify(requesterId, {
      type: "swap_declined",
      message: `${responderName} can't take over ${described}, so you're still covering it. You can ask someone else.`,
      relatedEntity: "session_excusal",
      relatedId: excusal.id,
    });
    return { excusal: await loadExcusal(excusal.id) };
  }

  if (excusal.session_date < todayStr()) {
    return swapError("conflict", "That session has already happened");
  }
  // Re-check: they may have picked up a clashing cover since being asked.
  const stillEligible = (await eligibleCovers(excusal, [requesterId])).some(
    (v) => v.user_id === userId,
  );
  if (!stillEligible) {
    return swapError(
      "conflict",
      "You're no longer free for that session, so you can't take it over",
    );
  }

  const now = new Date().toISOString();
  const soon = excusal.session_date <= addDays(todayStr(), 1);
  const { error } = await supabase
    .from("session_excusals")
    .update({
      cover_user_id: userId,
      cover_assigned_at: now,
      cover_reminded_at: soon ? now : null,
      swap_to_user_id: null,
      swap_requested_at: null,
    })
    .eq("id", excusal.id);
  if (error) throw error;

  const requesterName = (await nameOf(requesterId)) || "the other volunteer";
  safeNotify(requesterId, {
    type: "swap_accepted",
    message: `${responderName} is taking over ${described} — you're no longer covering it.`,
    relatedEntity: "session_excusal",
    relatedId: excusal.id,
  });
  safeNotify(excusal.tutor_id, {
    type: "cover_found",
    message: `${responderName} is now covering your ${described} (swapped with ${requesterName}).`,
    relatedEntity: "session_excusal",
    relatedId: excusal.id,
  });
  return { excusal: await loadExcusal(excusal.id) };
}

// After a volunteer is newly approved on a course, fill any of its
// upcoming excusals that are still without a cover.
async function fillUncoveredForCourse(courseId) {
  const { data, error } = await supabase
    .from("session_excusals")
    .select("id, cover_user_id")
    .eq("course_id", courseId)
    .gte("session_date", todayStr());
  if (error) throw error;

  for (const row of (data || []).filter((r) => !r.cover_user_id)) {
    await assignCover(row.id);
  }
}

// After a volunteer is taken off a course, hand their upcoming covers on it
// to someone else.
async function reassignCoversOf(userId, courseId) {
  const { data, error } = await supabase
    .from("session_excusals")
    .select(`*, courses(${COURSE_SCHEDULE})`)
    .eq("course_id", courseId)
    .eq("cover_user_id", userId)
    .gte("session_date", todayStr());
  if (error) throw error;

  for (const excusal of data || []) {
    notifyCoverReleased(
      excusal,
      userId,
      "you're no longer approved on that course",
    );
    await assignCover(excusal.id, { excludeUserIds: [userId] });
  }
}

// Sends a one-time reminder for each of this volunteer's covers happening
// today or tomorrow. There's no scheduled job in this app, so this runs
// whenever the user's notification bell polls (every page has one) —
// idempotent via cover_reminded_at.
async function sendDueCoverReminders(userId) {
  const today = todayStr();
  const tomorrow = addDays(today, 1);

  const { data, error } = await supabase
    .from("session_excusals")
    .select(`*, courses(${COURSE_SCHEDULE})`)
    .eq("cover_user_id", userId)
    .gte("session_date", today)
    .lte("session_date", tomorrow);
  if (error) throw error;

  const due = (data || []).filter((row) => !row.cover_reminded_at);
  for (const excusal of due) {
    const session = sessionOf(excusal.courses, excusal.session_type);
    const whenWord = excusal.session_date === today ? "today" : "tomorrow";

    const { error: updateError } = await supabase
      .from("session_excusals")
      .update({ cover_reminded_at: new Date().toISOString() })
      .eq("id", excusal.id);
    if (updateError) throw updateError;

    await notify(userId, {
      type: "cover_reminder",
      message: `Reminder: you're covering ${describeSession(excusal.courses, session, excusal.session_date)} — that's ${whenWord}.`,
      relatedEntity: "session_excusal",
      relatedId: excusal.id,
    });
  }
  return due.length;
}

module.exports = {
  COURSE_SCHEDULE,
  EXCUSAL_SELECT,
  sessionOf,
  describeSession,
  pickCover,
  eligibleCovers,
  assignCover,
  swapCandidates,
  requestSwap,
  withdrawSwap,
  respondToSwap,
  declineCover,
  notifyCoverReleased,
  fillUncoveredForCourse,
  reassignCoversOf,
  sendDueCoverReminders,
};
