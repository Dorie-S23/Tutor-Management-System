const supabase = require("../supabaseClient");

// Best-effort: a route's real work (approving an application, claiming a
// session, ...) must succeed or fail on its own merits. If the audit_log
// insert itself fails, that's a problem for the history feature, not a
// reason to roll back or fail the action that triggered it — so this never
// throws, it just logs a warning server-side.
async function recordAudit({
  entityType,
  entityId,
  action,
  actorId,
  before,
  after,
}) {
  const { error } = await supabase.from("audit_log").insert({
    entity_type: entityType,
    entity_id: String(entityId),
    action,
    actor_id: actorId ?? null,
    before: before ?? null,
    after: after ?? null,
  });

  if (error) {
    console.error(
      `audit_log insert failed for ${entityType} ${entityId} (${action}):`,
      error.message,
    );
  }
}

module.exports = { recordAudit };
