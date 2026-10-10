const supabase = require("../supabaseClient");

// Who organises what — shared by the hour-entry routes (which notify the
// right organisers when a session is logged) and the attendance
// verification routes (which scope the queue and guard the reviewer).
//
// Access rules mirror the rest of the app: the super-organiser sees every
// course; a plain organiser is limited to the courses they hold an approved
// organiser_requests row for — except organisers with no request rows at
// all (registered before requests existed), who keep full access.

async function organiserRequestRows(userId) {
  const { data, error } = await supabase
    .from("organiser_requests")
    .select("course_id, status")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

// True when this user may act on the given course as an organiser. Query
// errors fail closed (false) — an access check must never widen on a
// database hiccup.
async function hasCourseAccess(userId, courseId) {
  try {
    const { data: user } = await supabase
      .from("users")
      .select("id, role")
      .eq("id", userId)
      .maybeSingle();
    if (!user) return false;
    if (user.role === "super_organiser") return true;
    if (user.role !== "organiser") return false;

    const rows = await organiserRequestRows(userId);
    if (rows.length === 0) return true; // grandfathered organiser
    return rows.some(
      (row) =>
        row.status === "approved" &&
        Number(row.course_id) === Number(courseId),
    );
  } catch {
    return false;
  }
}

// Every organiser who should hear about activity on this course: the
// super-organiser, organisers approved for it, and grandfathered organisers
// (no request rows at all). Throws on query errors — callers treat the
// notification as best-effort.
async function organiserIdsForCourse(courseId) {
  const { data: orgUsers, error } = await supabase
    .from("users")
    .select("id, role")
    .in("role", ["organiser", "super_organiser"]);
  if (error) throw error;

  const ids = [];
  const plainOrganiserIds = [];
  (orgUsers || []).forEach((user) => {
    if (user.role === "super_organiser") ids.push(user.id);
    else plainOrganiserIds.push(user.id);
  });
  if (plainOrganiserIds.length === 0) return ids;

  const { data: rows, error: rowsError } = await supabase
    .from("organiser_requests")
    .select("user_id, course_id, status")
    .in("user_id", plainOrganiserIds);
  if (rowsError) throw rowsError;

  const rowsByUser = new Map();
  (rows || []).forEach((row) => {
    const list = rowsByUser.get(row.user_id) || [];
    list.push(row);
    rowsByUser.set(row.user_id, list);
  });

  plainOrganiserIds.forEach((userId) => {
    const theirs = rowsByUser.get(userId) || [];
    const approvedForCourse = theirs.some(
      (row) =>
        row.status === "approved" &&
        Number(row.course_id) === Number(courseId),
    );
    if (theirs.length === 0 || approvedForCourse) ids.push(userId);
  });

  return ids;
}

// The set of course ids this organiser may see, or null when they see every
// course (super-organiser, or a grandfathered organiser with no request
// rows). Returns undefined when the user isn't an organiser at all —
// distinct from null on purpose, so callers can tell "sees everything"
// apart from "not allowed in".
async function courseScopeForOrganiser(userId) {
  const { data: user } = await supabase
    .from("users")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();
  if (!user || !["organiser", "super_organiser"].includes(user.role)) {
    return undefined;
  }
  if (user.role === "super_organiser") return null;
  const rows = await organiserRequestRows(userId);
  if (rows.length === 0) return null; // grandfathered organiser
  return rows
    .filter((row) => row.status === "approved")
    .map((row) => Number(row.course_id));
}

module.exports = { hasCourseAccess, organiserIdsForCourse, courseScopeForOrganiser };
