const { BUCKET, SIGNED_URL_EXPIRY_SECONDS } = require("./transcriptStorage");

// Tutors file a monthly timesheet (their payroll claim) as a PDF, captured
// in the tutor's own browser at submit time — the server has no browser
// engine to render one with (production runs on Cloudflare Workers). The
// claims share the transcripts bucket, like profile timetables do at
// <userId>/timetable.pdf, so the existing private bucket and its anon policy
// cover them with no extra setup.
//
// Each month's claim lives at <userId>/timesheets/<monthStart>.pdf — the
// period key is already one per month, so the path doubles as the claim's
// identity and a resubmission simply overwrites it.

// A claim is normally far smaller than this, but the capture is a scale-2
// PNG whose height (and so weight) grows with the month's row count — 15 MB
// matches the timetable PDF's ceiling and stays well inside Supabase
// Storage's default file-size limit.
const MAX_TIMESHEET_PDF_BYTES = 15 * 1024 * 1024;

function timesheetPdfPath(userId, monthStart) {
  return `${userId}/timesheets/${monthStart}.pdf`;
}

// A cheap sanity check that the upload really is a PDF — the Content-Type
// header comes from the client, so it can't be trusted on its own. Same
// check as the transcript route: the spec allows leading junk before the
// magic bytes, which must appear somewhere in the first 1024 bytes.
function isPdfBuffer(body) {
  return (
    Buffer.isBuffer(body) &&
    body.length > 0 &&
    body.subarray(0, 1024).includes("%PDF-")
  );
}

// Answers a storage failure. The "bucket missing" case is a one-off setup
// problem (see the docs); anything else is treated as storage being
// temporarily unavailable.
function storageFailure(res, error) {
  console.error("Timesheet storage error:", error);
  if (String(error?.message || "").includes("Bucket not found")) {
    return res.status(503).json({
      error: "Timesheet storage bucket is missing in the Supabase project.",
    });
  }
  return res.status(502).json({
    error: "Couldn't store the timesheet PDF — try again shortly.",
  });
}

module.exports = {
  BUCKET,
  SIGNED_URL_EXPIRY_SECONDS,
  MAX_TIMESHEET_PDF_BYTES,
  timesheetPdfPath,
  isPdfBuffer,
  storageFailure,
};
