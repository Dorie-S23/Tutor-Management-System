// A session can only be logged while it's happening: from its scheduled
// start until GRACE_MINUTES after its scheduled end. Enforced server-side
// here and mirrored client-side in public/js/sessionTiming.js so the Log
// Hours pages can show the same rule — the server always re-checks.

const GRACE_MINUTES = 10;

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function minutesOf(value) {
  const [hours, minutes] = sliceTime(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function localDateStr(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// True only while "now" (local time) sits inside the session's window on
// the session's own date — never before its start, and never later than
// the grace period after its end.
function isWithinLoggingWindow(date, startTime, endTime, now = new Date()) {
  if (String(date) !== localDateStr(now)) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return (
    nowMinutes >= minutesOf(startTime) &&
    nowMinutes <= minutesOf(endTime) + GRACE_MINUTES
  );
}

module.exports = { GRACE_MINUTES, isWithinLoggingWindow };
