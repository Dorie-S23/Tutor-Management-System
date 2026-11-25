// The server-side twin of the frontend date mask (public/js/date-mask.js):
// a real date has year >= 1, a month from 01-12, and a day within that
// month's length, leap years included. Routes check values with these
// before writing or filtering dates, so an impossible value like
// "2026-13-99" is a clear 400 instead of a Postgres error surfacing as a
// 500 after the fact.

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// Returns a message naming what's wrong with `value`, or null when it's a
// real YYYY-MM-DD calendar date. `field` is what the message calls the
// input — callers whose inputs have their own names (query params, URL
// params) pass that name through.
function dateError(value, field = "date") {
  if (value == null || value === "") {
    return `${field} is required (YYYY-MM-DD)`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      year >= 1 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month)
    ) {
      return null;
    }
  }
  return `${field} must be a valid calendar date (YYYY-MM-DD)`;
}

// The same, for a "YYYY-MM" month — the month picker's format has no day
// to check, only a real year and a month from 01-12.
function monthError(value, field = "month") {
  if (value == null || value === "") {
    return `${field} is required (YYYY-MM)`;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(String(value));
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 1 && month >= 1 && month <= 12) {
      return null;
    }
  }
  return `${field} must be a valid month (YYYY-MM)`;
}

// Things a timesheet period may be named by: the month picker's "YYYY-MM"
// or a full date inside that month ("YYYY-MM-DD"). Runs the check matching
// the shape given.
function monthOrDateError(value, field = "date") {
  return /^\d{4}-\d{2}$/.test(String(value))
    ? monthError(value, field)
    : dateError(value, field);
}

module.exports = { dateError, monthError, monthOrDateError };
