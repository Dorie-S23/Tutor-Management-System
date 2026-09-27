// Mirrors server/loggingWindow.js so the Log Hours pages can show the same
// rule the server enforces: a session can only be logged while it's
// happening — from its scheduled start until GRACE_MINUTES after its
// scheduled end, on the session's own day. The server always re-checks, so
// this copy only drives what the pages display.

export const GRACE_MINUTES = 10;

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

// "17:00" → "17:10": the clock time the session's logging window closes.
// A session ending at the very end of the day caps at 23:59 rather than
// wrapping past midnight (same effect as the server rule, which can never
// call it expired once the day is over).
function closingTime(endTime) {
  const total = minutesOf(endTime) + GRACE_MINUTES;
  if (total >= 24 * 60) return "23:59";
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// "open" while the session can be logged right now, "early" before its
// start, "expired" once the grace period has passed — the server's three
// possible answers, as the pages need to tell them apart.
export function windowStatus(dateStr, startTime, endTime, now = new Date()) {
  const today = localDateStr(now);
  if (String(dateStr) !== today) {
    return String(dateStr) < today ? "expired" : "early";
  }
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (nowMinutes < minutesOf(startTime)) return "early";
  if (nowMinutes > minutesOf(endTime) + GRACE_MINUTES) return "expired";
  return "open";
}

// One-line hint for a session chip.
export function windowNote(dateStr, startTime, endTime, now = new Date()) {
  const status = windowStatus(dateStr, startTime, endTime, now);
  if (status === "open") {
    return `Log now — closes ${closingTime(endTime)}`;
  }
  if (status === "early") {
    return `Logging opens at ${sliceTime(startTime)}`;
  }
  return "Logging window closed";
}

// The form's explanation when someone tries to log outside the window.
// Empty while the window is open.
export function windowBlockMessage(
  dateStr,
  startTime,
  endTime,
  now = new Date(),
) {
  const status = windowStatus(dateStr, startTime, endTime, now);
  if (status === "early") {
    return `You can only log a session while it's happening — logging opens at ${sliceTime(startTime)}.`;
  }
  if (status === "expired") {
    return `You can only log a session while it's happening — logging closed at ${closingTime(endTime)}.`;
  }
  return "";
}
