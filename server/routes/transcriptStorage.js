const supabase = require("../supabaseClient");

// Applicants upload a transcript (their academic record) before they can
// apply to tutor or volunteer for a course, and organisers view it from the
// course boards via short-lived signed URLs. Files live in a private
// Supabase Storage bucket — the server also deploys to Cloudflare Workers,
// so nothing can be held on local disk. Each user's transcript is stored at
// <userId>/transcript.<ext>, which is unambiguous across both flows because
// tutors and students share one auth user id (see routes/auth.js).

const BUCKET = "transcripts";

// A transcript is a small document, so 5 MB comfortably covers a few-page
// PDF or a phone photo of one.
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

// Short-lived: long enough for an organiser to open the file, short enough
// that a copied URL stops working soon after.
const SIGNED_URL_EXPIRY_SECONDS = 300;

// The transcript files on record for a user. Supabase's list() returns the
// direct children of the folder, so filtering on the "transcript." prefix
// finds the single file uploads write. Newest first, so that if an old
// upload under an earlier extension ever lingers, the current one wins.
async function listTranscripts(userId) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(String(userId));

  if (error) return { files: [], error };

  const files = (data || [])
    .filter((entry) => String(entry.name || "").startsWith("transcript."))
    .sort(
      (a, b) =>
        String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
        String(a.name).localeCompare(String(b.name)),
    );

  return { files, error: null };
}

// Used by the apply routes: an application is refused until a transcript is
// on file. `error` distinguishes "storage is down or misconfigured" from
// "nothing uploaded yet", so callers can answer differently for each.
async function hasTranscript(userId) {
  const { files, error } = await listTranscripts(userId);
  return { has: !error && files.length > 0, error };
}

// Answers a storage failure. The "bucket missing" case is a one-off setup
// problem the team fixes in the Supabase dashboard (see the docs); anything
// else is treated as storage being temporarily unavailable.
function storageFailure(res, error) {
  console.error("Transcript storage error:", error);
  if (String(error?.message || "").includes("Bucket not found")) {
    return res.status(503).json({
      error:
        "Transcript storage isn't set up yet — the 'transcripts' bucket is missing in the Supabase project.",
    });
  }
  return res.status(502).json({
    error: "Transcript storage is unavailable — try again shortly.",
  });
}

module.exports = {
  BUCKET,
  MAX_TRANSCRIPT_BYTES,
  SIGNED_URL_EXPIRY_SECONDS,
  listTranscripts,
  hasTranscript,
  storageFailure,
};
