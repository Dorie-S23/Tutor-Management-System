// Mirrors DAY_NAMES in public/js/timetable-parser.js — index matches JS Date.getDay()
// (0 = Sunday) and the tutor_busy_times.day_of_week column.
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

module.exports = { DAY_NAMES };
