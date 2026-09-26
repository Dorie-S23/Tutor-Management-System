const express = require("express");
const supabase = require("../supabaseClient");

const router = express.Router();

// GET /api/notifications?userId=... — a user's notifications, newest first.
// Capped at 50 since this backs a bell-icon dropdown, not a full history page.
router.get("/", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/notifications/read-all — mark every one of a user's unread
// notifications as read. Registered before /:id so "read-all" doesn't get
// swallowed by that route's :id param.
router.patch("/read-all", async (req, res) => {
  const { userId } = req.body ?? {};
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const { error } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("user_id", userId)
    .eq("read", false);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

// PATCH /api/notifications/:id — mark one notification read (or back to unread)
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid notification id" });
  }

  const { read } = req.body ?? {};
  if (typeof read !== "boolean") {
    return res.status(400).json({ error: "read must be a boolean" });
  }

  const { data, error } = await supabase
    .from("notifications")
    .update({ read })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      return res.status(404).json({ error: "Notification not found" });
    }
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

module.exports = router;
