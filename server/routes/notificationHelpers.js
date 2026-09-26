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

module.exports = { notify };
