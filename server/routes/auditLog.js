const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// GET /api/audit-log?entityType=&entityId=&limit=
//
// The organiser-facing "Full Change History" feed: every recorded
// approve/reject/claim/withdraw across tutor applications and volunteer
// sessions, newest first. entityType/entityId narrow it to one record's
// history (e.g. everything that ever happened to a single application);
// left out, it's the whole feed capped at `limit` (default 100, max 500).
router.get("/", async (req, res) => {
  const { entityType, entityId, limit } = req.query;

  const parsedLimit = Number(limit);
  const cappedLimit = Math.min(
    Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
    500,
  );

  let query = supabase
    .from("audit_log")
    .select("*, users(name, email)")
    .order("created_at", { ascending: false })
    .limit(cappedLimit);

  if (entityType) query = query.eq("entity_type", entityType);
  if (entityId) query = query.eq("entity_id", String(entityId));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
