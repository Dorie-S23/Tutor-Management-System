const supabase = require("../supabaseClient");

// Shared by every route that needs to ping a user — mirrors the insert
// courses.js's notifySessionChange already did inline, pulled out so the
// same shape (and the same "never throw into the caller's response" shape,
// via fire-and-forget .catch() at each call site) is used everywhere.
async function notify(userId, { type, message, relatedEntity, relatedId }) {
  const { error } = await supabase.from("notifications").insert({
    user_id: userId,
    type,
    message,
    related_entity: relatedEntity,
    related_id: relatedId != null ? String(relatedId) : null,
    read: false,
  });
  if (error) throw error;
}

// "6 Oct 2026" — how attendance notifications name a session date (see
// hourEntries.js and attendanceVerification.js). UTC throughout so the day
// never shifts with the server's timezone.
function formatShortDate(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

module.exports = { notify, formatShortDate };
