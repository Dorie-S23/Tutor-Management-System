const express = require("express");
const supabase = require("../supabaseClient");
const { BUCKET, SIGNED_URL_EXPIRY_SECONDS } = require("./transcriptStorage");

// Tutors and student volunteers can keep a copy of their class-timetable
// PDF on their profile page, to re-open or replace later. The file shares
// the private transcripts bucket — and its one-folder-per-user layout and
// anon-role policy — rather than needing a second bucket set up in every
// Supabase project. It's stored at <userId>/timetable.pdf, which can't be
// mistaken for a transcript: listTranscripts() only matches "transcript.*".
//
// Mounted at /api/profile/:userId/timetable (see app.js), so the user id
// comes from the parent path via mergeParams.

const router = express.Router({ mergeParams: true });

const FILE_NAME = "timetable.pdf";

// A timetable export is normally a few KB to a few hundred KB; 5 MB matches
// the transcript limit and leaves plenty of room for a scanned copy.
const MAX_TIMETABLE_BYTES = 5 * 1024 * 1024;

function storagePath(userId) {
  return `${userId}/${FILE_NAME}`;
}

function isPdfBuffer(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) return false;
  // The spec allows leading junk before the magic bytes; they must appear
  // somewhere in the first 1024 bytes (same check as the timetable parser).
  return body.subarray(0, 1024).includes("%PDF-");
}

// The stored timetable's listing entry, or null when none is on file.
async function findTimetable(userId) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(String(userId));
  if (error) return { file: null, error };
  const file = (data || []).find((entry) => entry.name === FILE_NAME) || null;
  return { file, error: null };
}

// Same split as the transcript routes: a missing bucket is a one-off setup
// problem; anything else is storage being temporarily unavailable.
function storageFailure(res, error) {
  console.error("Timetable storage error:", error);
  if (String(error?.message || "").includes("Bucket not found")) {
    return res.status(503).json({
      error:
        "Timetable storage isn't set up yet — the 'transcripts' bucket is missing in the Supabase project.",
    });
  }
  return res.status(502).json({
    error: "Timetable storage is unavailable — try again shortly.",
  });
}

// GET /api/profile/:userId/timetable — whether a timetable is on file, so
// the profile page can render its current state.
router.get("/", async (req, res) => {
  const { file, error } = await findTimetable(req.params.userId);
  if (error) return storageFailure(res, error);
  if (!file) return res.json({ uploaded: false });

  res.json({
    uploaded: true,
    fileName: file.name,
    size: file.metadata?.size ?? null,
    updatedAt: file.updated_at ?? null,
  });
});

// POST /api/profile/:userId/timetable — upload (or replace) the timetable.
// Raw PDF body, not multipart, like the transcript and parse routes.
router.post(
  "/",
  express.raw({ type: "application/pdf", limit: MAX_TIMETABLE_BYTES }),
  async (req, res) => {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "A user id is required." });
    }
    if (!req.is("application/pdf") || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: "Your timetable must be a PDF." });
    }
    if (!isPdfBuffer(req.body)) {
      return res
        .status(400)
        .json({ error: "That file doesn't look like a PDF." });
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath(userId), req.body, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (error) return storageFailure(res, error);

    res.status(201).json({
      uploaded: true,
      fileName: FILE_NAME,
      size: req.body.length,
      updatedAt: new Date().toISOString(),
    });
  },
);

// GET /api/profile/:userId/timetable/signed-url — a short-lived URL the
// browser can open directly; the bucket itself stays private.
router.get("/signed-url", async (req, res) => {
  const { file, error } = await findTimetable(req.params.userId);
  if (error) return storageFailure(res, error);
  if (!file) return res.status(404).json({ error: "No timetable on file." });

  const { data, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath(req.params.userId), SIGNED_URL_EXPIRY_SECONDS);
  if (signError) return storageFailure(res, signError);

  res.json({ url: data.signedUrl, expiresIn: SIGNED_URL_EXPIRY_SECONDS });
});

// DELETE /api/profile/:userId/timetable — remove the stored timetable.
// Idempotent: deleting when nothing is on file still answers 200.
router.delete("/", async (req, res) => {
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([storagePath(req.params.userId)]);
  if (error) return storageFailure(res, error);
  res.json({ uploaded: false });
});

// express.raw rejects oversized uploads with a raw-body error before the
// upload route above ever runs — answer with the size limit instead of a
// bare 500.
router.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: `Timetable is too large — the limit is ${MAX_TIMETABLE_BYTES / 1024 / 1024} MB.`,
    });
  }
  next(err);
});

module.exports = router;
