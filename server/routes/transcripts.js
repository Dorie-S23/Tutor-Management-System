const express = require("express");
const supabase = require("../supabaseClient");
const {
  BUCKET,
  MAX_TRANSCRIPT_BYTES,
  SIGNED_URL_EXPIRY_SECONDS,
  listTranscripts,
  storageFailure,
} = require("./transcriptStorage");

const router = express.Router();

// Accepted upload formats, mapped to the extension used in storage. A PDF
// is the normal case; images cover a phone photo of the printed document.
const ALLOWED_TYPES = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function requestedContentType(req) {
  return String(req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

// A cheap sanity check that the upload really is what its Content-Type
// claims to be — the header comes from the client, so it can't be trusted
// on its own.
function matchesMagicBytes(body, contentType) {
  if (contentType === "application/pdf") {
    // The spec allows leading junk before the magic bytes; they must appear
    // somewhere in the first 1024 bytes (same check as the timetable route).
    return body.subarray(0, 1024).includes("%PDF-");
  }
  const signature =
    contentType === "image/png"
      ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      : [0xff, 0xd8, 0xff];
  return signature.every((byte, index) => body[index] === byte);
}

// GET /api/transcripts/:userId — whether a transcript is on file, so the
// upload section on the application pages can render its current state.
router.get("/:userId", async (req, res) => {
  const { files, error } = await listTranscripts(req.params.userId);
  if (error) return storageFailure(res, error);

  if (files.length === 0) {
    return res.json({ uploaded: false });
  }

  const file = files[0];
  res.json({
    uploaded: true,
    fileName: file.name,
    size: file.metadata?.size ?? null,
    contentType: file.metadata?.mimetype ?? null,
    updatedAt: file.updated_at ?? null,
  });
});

// POST /api/transcripts/:userId — upload (or replace) the user's transcript.
// Raw body, not multipart, like the timetable route — one file, no fields.
router.post(
  "/:userId",
  express.raw({
    type: Object.keys(ALLOWED_TYPES),
    limit: MAX_TRANSCRIPT_BYTES,
  }),
  async (req, res) => {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "A user id is required." });
    }

    const contentType = requestedContentType(req);
    const extension = ALLOWED_TYPES[contentType];
    if (!extension || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res
        .status(400)
        .json({ error: "Uploaded file must be a PDF, PNG, or JPEG." });
    }

    if (!matchesMagicBytes(req.body, contentType)) {
      return res
        .status(400)
        .json({ error: "That file doesn't look like a PDF, PNG, or JPEG." });
    }

    const fileName = `transcript.${extension}`;
    const path = `${userId}/${fileName}`;

    // Replacing: drop any transcript stored under a different extension, so
    // only one file is ever on record for a user. Same-name replacement is
    // handled by upsert below.
    const { files } = await listTranscripts(userId);
    const stale = files
      .map((entry) => `${userId}/${entry.name}`)
      .filter((existing) => existing !== path);
    if (stale.length > 0) {
      const { error: removeError } = await supabase.storage
        .from(BUCKET)
        .remove(stale);
      if (removeError) {
        console.error(
          "Transcript replace: could not remove old file:",
          removeError,
        );
      }
    }

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.body, { contentType, upsert: true });

    if (error) return storageFailure(res, error);

    res.status(201).json({
      uploaded: true,
      fileName,
      size: req.body.length,
      contentType,
      updatedAt: new Date().toISOString(),
    });
  },
);

// GET /api/transcripts/:userId/signed-url — a short-lived URL an organiser's
// browser can open directly; the bucket itself stays private.
router.get("/:userId/signed-url", async (req, res) => {
  const { files, error } = await listTranscripts(req.params.userId);
  if (error) return storageFailure(res, error);

  if (files.length === 0) {
    return res.status(404).json({ error: "No transcript on file." });
  }

  const { data, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(
      `${req.params.userId}/${files[0].name}`,
      SIGNED_URL_EXPIRY_SECONDS,
    );

  if (signError) return storageFailure(res, signError);

  res.json({ url: data.signedUrl, expiresIn: SIGNED_URL_EXPIRY_SECONDS });
});

// express.raw rejects oversized uploads with a raw-body error before the
// upload route above ever runs — answer with the size limit instead of a
// bare 500.
router.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: `Transcript is too large — the limit is ${MAX_TRANSCRIPT_BYTES / 1024 / 1024} MB.`,
    });
  }
  next(err);
});

module.exports = router;
