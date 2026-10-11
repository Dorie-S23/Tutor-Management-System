const supabase = require("../supabaseClient");
const { emailNotification } = require("../notificationEmails");

// The in-app row is the source of truth, and it's committed before the email
// goes out, so email is strictly a side channel: not awaited (a slow Resend
// call must not hold up the response the caller is about to send) and never
// throwing (an undeliverable email is not a failed request).
//
// Worth knowing: on Cloudflare Workers a promise still pending when the
// response is sent can be cancelled, so an email may be dropped under load.
// That risk already applies to the fire-and-forget notify() calls several
// routes make; closing it properly means threading a waitUntil context
// through them, which is a bigger change than this feature needs.
function emailAsync(userId, { type, message }) {
  emailNotification(userId, { type, message }).catch((err) =>
    console.warn(`Failed to email ${type} notification:`, err),
  );
}

function row(userId, { type, message, relatedEntity, relatedId }) {
  return {
    user_id: userId,
    type,
    message,
    related_entity: relatedEntity,
    related_id: relatedId != null ? String(relatedId) : null,
    read: false,
  };
}

// Shared by every route that needs to ping a user — mirrors the insert
// courses.js's notifySessionChange already did inline, pulled out so the
// same shape (and the same "never throw into the caller's response" shape,
// via fire-and-forget .catch() at each call site) is used everywhere.
async function notify(userId, payload) {
  const { error } = await supabase
    .from("notifications")
    .insert(row(userId, payload));
  if (error) throw error;
  emailAsync(userId, payload);
}

// The broadcast version — one announcement to many people, e.g. every tutor
// and volunteer on a course whose session time just moved. The insert stays a
// single bulk query, because looping notify() would cost N database round
// trips to say one thing; only the email fans out per recipient, since Resend
// takes one address at a time.
async function notifyMany(userIds, payload) {
  const ids = [...new Set(userIds ?? [])].filter(Boolean);
  if (ids.length === 0) return;

  const { error } = await supabase
    .from("notifications")
    .insert(ids.map((userId) => row(userId, payload)));
  if (error) throw error;

  for (const userId of ids) emailAsync(userId, payload);
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

module.exports = { notify, notifyMany, formatShortDate };
