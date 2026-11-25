const { DAY_NAMES } = require("../dayNames");

// Which of a course's two weekly slots a logged time range matches: its
// tutorial (Day_of_tut / tutor_*) or its lab (Day_of_lab / lab_*), or an
// empty array when it matches neither. Day names are stored the same way
// DAY_NAMES spells them. Shared by the hour-entry routes (which enforce the
// match) and the attendance verification queue (which labels each logged
// session Tutorial or Lab with it).

function sliceTime(value) {
  return value == null ? "" : String(value).slice(0, 5);
}

function matchingSlotTypes(course, date, startTime, endTime) {
  if (!date || !startTime || !endTime) return [];
  const [y, m, d] = String(date).split("-").map(Number);
  if (!y || !m || !d) return [];
  const weekday = DAY_NAMES[new Date(y, m - 1, d).getDay()];
  const start = sliceTime(startTime);
  const end = sliceTime(endTime);
  return [
    [
      "tutorial",
      course.Day_of_tut,
      course.tutor_start_time,
      course.tutor_end_time,
    ],
    ["lab", course.Day_of_lab, course.lab_start_time, course.lab_end_time],
  ]
    .filter(
      ([, day, slotStart, slotEnd]) =>
        Boolean(day) &&
        day === weekday &&
        sliceTime(slotStart) === start &&
        sliceTime(slotEnd) === end,
    )
    .map(([type]) => type);
}

module.exports = { sliceTime, matchingSlotTypes };
