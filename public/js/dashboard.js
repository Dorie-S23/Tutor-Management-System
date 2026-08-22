import { highlightActiveTab } from './nav.js';
import { getWeekStart, getWeekTotal, todayStr } from './storage.js';

const WEEKLY_HOUR_LIMIT = 6;

highlightActiveTab();

const hoursWorkedEl = document.getElementById('stat-hours-worked');
const hoursRemainingEl = document.getElementById('stat-hours-remaining');
const hoursSublabelEl = document.getElementById('stat-hours-sublabel');

function renderHoursStats() {
  const weekStart = getWeekStart(todayStr());
  const worked = getWeekTotal(weekStart);
  const remaining = WEEKLY_HOUR_LIMIT - worked;

  hoursWorkedEl.textContent = worked;

  if (remaining >= 0) {
    hoursRemainingEl.textContent = remaining;
    hoursRemainingEl.classList.remove('danger');
    hoursSublabelEl.textContent = `of ${WEEKLY_HOUR_LIMIT} hrs/week limit`;
  } else {
    hoursRemainingEl.textContent = 0;
    hoursRemainingEl.classList.add('danger');
    hoursSublabelEl.textContent = `over the ${WEEKLY_HOUR_LIMIT} hrs/week limit by ${-remaining}`;
  }
}

renderHoursStats();
