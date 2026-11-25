// log-hours.js is the tutor-only "Log your hours" wizard: it loads the
// modules the tutor is approved to tutor (as chips and select options),
// lets them pick one of that module's upcoming scheduled sessions — which
// locks the date and times to that slot — and rolls every logged entry up
// into the month table below. The real nav.js/highlightTarget.js/storage.js/
// sessionTiming.js imports can't load here (they fetch the API or redirect),
// so all four import statements are stripped and their functions are
// replaced by stubs appended after the real source — in the one eval scope,
// the later function declarations win (and hoist above the page's top-level
// guard).
// Everything else (role guard, module loading, session chips, hours-from-
// times math, the confirm dialog wrapper, month navigation, and the whole
// submit/edit/delete flow) is the real code running inside jsdom, with the
// //# sourceURL tag so Jest's v8 coverage attributes the lines back to the
// real file.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const rawLogHoursJs = fs.readFileSync(
  path.join(__dirname, "log-hours.js"),
  "utf8",
);

const STUBS = `
function highlightActiveTab() {}
function renderWelcomeHeading() {}
// Mirrors storage.js: the caller gets the user back only when their role
// is allowed — everyone else is redirected away and gets null (the page's
// top-level guard then throws, letting the redirect happen).
function requireRole(role) {
  const user = window.__user;
  const allowed = Array.isArray(role) ? role : [role];
  if (!user || !allowed.includes(user.role)) {
    window.location.href = user ? "dashboard.html" : "login.html";
    return null;
  }
  return user;
}
function addEntry(entry) {
  window.__added.push(entry);
  return Promise.resolve(entry);
}
function updateEntry(id, entry) {
  window.__updated.push({ id, entry });
  return Promise.resolve(entry);
}
function deleteEntry(id) {
  window.__deleted.push(id);
  return Promise.resolve();
}
function findDuplicateEntry(payload, excludeId) {
  window.__duplicateQueries.push([payload, excludeId ?? null]);
  return Promise.resolve(window.__duplicate);
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function getMonthStart(dateStr) {
  return dateStr.slice(0, 7) + "-01";
}
function addMonths(monthStart, months) {
  const [y, m] = monthStart.split("-").map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-01";
}
function toDateStr(date) {
  return (
    date.getFullYear() +
    "-" +
    pad2(date.getMonth() + 1) +
    "-" +
    pad2(date.getDate())
  );
}
function getEntriesForMonth(monthStart) {
  window.__monthQueries.push(monthStart);
  return Promise.resolve(window.__entries);
}
function todayStr() {
  return window.__today;
}
// sessionTiming.js reads the real clock, which would make these tests
// flaky around midnight — hand the page whatever the test asked for
// instead. The three functions mirror its server/loggingWindow.js rule.
function windowStatus() {
  return window.__status;
}
function windowNote() {
  return window.__note;
}
function windowBlockMessage() {
  return window.__blockMessage;
}
// highlightTarget.js — the notification deep-link helpers. consumeQueryParam
// answers with whatever the test parked under window.__queryParams;
// scrollAndHighlight records which row it was handed and marks it the way
// the real one flashes it.
function consumeQueryParam(param) {
  return window.__queryParams[param] ?? null;
}
function scrollAndHighlight(el) {
  if (!el) return;
  window.__highlighted = el.dataset.entryId || null;
  el.classList.add("highlight-flash");
}
// storage.js getEntries() — the highlight lookup reads the tutor's full
// entry list (getEntriesForMonth above only serves the month table).
function getEntries() {
  return Promise.resolve(window.__entries);
}
`;

const PAGE = `
  <nav class="tab-nav">
    <a href="dashboard.html" id="dashboard-nav-link"></a>
    <a href="my-sessions.html" id="my-sessions-nav-link"></a>
    <a href="calendar.html" id="calendar-nav-link"></a>
    <a href="timesheets.html" id="timesheets-nav-link"></a>
    <a href="modules.html" id="modules-nav-link"></a>
    <a href="profile.html" id="profile-nav-link"></a>
  </nav>
  <main>
    <section id="courseStep">
      <div id="courseChips"></div>
    </section>
    <section id="sessionStep" hidden>
      <div id="sessionChips"></div>
    </section>
    <section id="attendanceCard" hidden>
      <p id="scheduledBox" hidden>
        <span id="scheduledWhen"></span>
        <span id="scheduledVenue"></span>
      </p>
      <h2 id="form-title">Log your hours</h2>
      <form id="entry-form">
        <input type="hidden" id="entry-id">
        <input type="hidden" id="hours">
        <input type="date" id="date" readonly>
        <input type="time" id="startTime" readonly>
        <input type="time" id="endTime" readonly>
        <select id="taskType">
          <option value="Tutoring">Tutoring</option>
          <option value="Marking">Marking</option>
        </select>
        <select id="courseSelect"><option value="">Select a module</option></select>
        <p id="hours-display">—</p>
        <textarea id="notes"></textarea>
        <p id="form-error" hidden></p>
        <button type="submit" id="submit-btn">Add entry</button>
        <button type="button" id="cancel-edit-btn" hidden>Cancel</button>
      </form>
    </section>
    <button type="button" id="prev-month-btn"></button>
    <span id="month-label"></span>
    <button type="button" id="next-month-btn"></button>
    <p>Total this month: <strong id="month-total">0</strong> hours</p>
    <table><tbody id="entries-body"></tbody></table>
    <p id="empty-state" hidden></p>
    <dialog id="confirm-modal">
      <p id="confirm-modal-message"></p>
      <button type="button" id="confirm-modal-cancel-btn">Cancel</button>
      <button type="button" id="confirm-modal-confirm-btn">Confirm</button>
    </dialog>
    <output id="toast"></output>
  </main>
`;

const APPLICATIONS = [
  {
    status: "approved",
    course_id: "3",
    courses: {
      id: "3",
      course_code: "COMS1015A",
      course_name: "Computer Science 1A",
      Day_of_tut: "Wednesday",
      tutor_start_time: "09:00:00",
      tutor_end_time: "11:00:00",
      venues: "MSB 101",
    },
  },
  {
    status: "pending",
    course_id: "9",
    courses: {
      id: "9",
      course_code: "PHYS1014",
      course_name: "Physics 1",
      Day_of_tut: "Friday",
      tutor_start_time: "10:00:00",
      tutor_end_time: "12:00:00",
      venues: "",
    },
  },
  {
    status: "approved",
    course_id: "4",
    courses: {
      id: "4",
      course_code: "MATH1000",
      course_name: "Intro Maths",
      Day_of_tut: "Thursday",
      tutor_start_time: "14:00:00",
      tutor_end_time: "16:00:00",
      venues: "TBC",
    },
  },
];

const ENTRY_E1 = {
  id: "e1",
  date: "2026-09-29",
  hours: 2,
  startTime: "09:00",
  endTime: "11:00",
  taskType: "Marking",
  courseId: 4,
  notes: "bring notes",
};

const ENTRY_E2 = {
  id: "e2",
  date: "2026-09-30",
  hours: 1.5,
  startTime: null,
  endTime: null,
  taskType: "Tutoring",
  courseId: null,
  notes: "",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

function loadLogHours({
  user = { id: "tutor-1", name: "Tutor One", role: "tutor" },
  entries = [],
  applicationsRespond = () => jsonResponse(APPLICATIONS),
  highlightEntry = null,
} = {}) {
  // The redirect on the not-logged-in path is jsdom's "Not implemented:
  // navigation" — swallow it through a quiet virtual console.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const logHoursJs = rawLogHoursJs
    .replace(/import\s*{[^}]*}\s*from\s*["']\.\/nav\.js["'];?/, "")
    .replace(/import\s*{[^}]*}\s*from\s*["']\.\/highlightTarget\.js["'];?/, "")
    .replace(/import\s*{[\s\S]*?}\s*from\s*["']\.\/storage\.js["'];?/, "")
    .replace(/import\s*{[\s\S]*?}\s*from\s*["']\.\/sessionTiming\.js["'];?/, "")
    // Top-level await only works in a module; a classic script (which is
    // what jsdom executes) needs the bare calls — the page has two.
    .replace(/\nawait ([a-zA-Z]+)\(\);/g, "\n$1();");

  const fetches = [];

  const dom = new JSDOM(`<!doctype html><html><body>${PAGE}</body></html>`, {
    url: "http://localhost/log-hours.html",
    runScripts: "dangerously",
    virtualConsole,
    beforeParse(window) {
      // jsdom ships HTMLDialogElement but not its modal API — stub just
      // enough for the delete-confirmation dialog.
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
      // jsdom has no layout, so record the wizard's scroll-into-view calls
      // instead of performing them.
      window.HTMLElement.prototype.scrollIntoView = function (options) {
        window.__scrollIntoViewCalls.push(options);
      };
      window.__user = user;
      window.__today = "2026-09-30"; // a Wednesday
      window.__entries = entries;
      window.__duplicate = null;
      window.__status = "open";
      window.__note = "";
      window.__blockMessage = "";
      window.__added = [];
      window.__updated = [];
      window.__deleted = [];
      window.__monthQueries = [];
      window.__duplicateQueries = [];
      window.__scrollIntoViewCalls = [];
      window.__queryParams = highlightEntry ? { highlightEntry } : {};
      window.__highlighted = null;
      window.fetch = (url) => {
        fetches.push(String(url));
        return applicationsRespond(String(url));
      };
    },
  });

  try {
    dom.window.eval(
      `${logHoursJs}\n${STUBS}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "log-hours.js")).href}`,
    );
  } catch (err) {
    // The not-logged-in / wrong-role path throws by design after redirecting.
  }

  return { win: dom.window, fetches };
}

// Types a value into one of the time fields, firing the "input" event the
// page listens on to recompute the hours figure.
function setTime(win, id, value) {
  const field = win.document.getElementById(id);
  field.value = value;
  field.dispatchEvent(new win.Event("input", { bubbles: true }));
}

function submitForm(win) {
  win.document
    .getElementById("entry-form")
    .dispatchEvent(
      new win.Event("submit", { bubbles: true, cancelable: true }),
    );
}

describe("log-hours.js", () => {
  test("redirects away when nobody is signed in", () => {
    const { win } = loadLogHours({ user: null });

    expect(win.__monthQueries).toHaveLength(0); // render() never ran
    expect(win.__added).toHaveLength(0);
    win.close();
  });

  test("stays tutor-only — students and organisers are sent away", () => {
    const student = loadLogHours({
      user: { id: "s1", name: "Student One", role: "student" },
    });
    expect(student.win.__monthQueries).toHaveLength(0);
    expect(student.fetches).toHaveLength(0);
    student.win.close();

    const organiser = loadLogHours({
      user: { id: "o1", name: "Organiser One", role: "organiser" },
    });
    expect(organiser.win.__monthQueries).toHaveLength(0);
    expect(organiser.fetches).toHaveLength(0);
    organiser.win.close();
  });

  test("loads the approved modules and wires the role-based nav", async () => {
    const { win, fetches } = loadLogHours({});
    await flush();

    const doc = win.document;
    expect(fetches).toEqual(["/api/tutor-applications?tutorId=tutor-1"]);
    const options = doc.getElementById("courseSelect").options;
    expect(options).toHaveLength(3); // placeholder + the two approved modules
    expect(options[1].textContent).toBe("COMS1015A — Computer Science 1A");
    expect(options[2].value).toBe("4");

    // The chip grid mirrors the select — the pending application is not
    // one of the tutor's modules.
    const chips = doc.querySelectorAll(".course-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector(".course-chip__code").textContent).toBe(
      "COMS1015A",
    );
    expect(chips[0].querySelector(".course-chip__name").textContent).toBe(
      "Computer Science 1A",
    );

    // Tutor: student-only links hidden, profile link kept.
    expect(doc.getElementById("my-sessions-nav-link").hidden).toBe(true);
    expect(doc.getElementById("profile-nav-link").hidden).toBe(false);
    expect(doc.getElementById("dashboard-nav-link").getAttribute("href")).toBe(
      "dashboard.html",
    );
    win.close();
  });

  test("shows a retry message when the modules can't be loaded", async () => {
    const { win } = loadLogHours({
      applicationsRespond: () => Promise.reject(new Error("offline")),
    });
    await flush();

    const doc = win.document;
    expect(doc.getElementById("courseChips").textContent).toContain(
      "Couldn't load your modules right now",
    );
    expect(doc.getElementById("courseSelect").options).toHaveLength(1);
    win.close();
  });

  test("recomputes hours from start/end times", async () => {
    const { win } = loadLogHours({});
    await flush();

    const doc = win.document;
    const hoursField = doc.getElementById("hours");
    const display = doc.getElementById("hours-display");
    expect(display.textContent).toBe("—"); // nothing picked yet

    setTime(win, "startTime", "09:00");
    setTime(win, "endTime", "09:20"); // under half an hour — not billable
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("Rounds to 0h");

    setTime(win, "endTime", "08:00"); // not after the start — left alone
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("Rounds to 0h");

    setTime(win, "endTime", "10:20"); // 80 minutes → 1 hour
    expect(hoursField.value).toBe("1");
    expect(display.textContent).toBe("1h");

    setTime(win, "endTime", "11:00"); // 2 hours
    expect(hoursField.value).toBe("2");
    expect(display.textContent).toBe("2h");

    setTime(win, "endTime", ""); // incomplete range — cleared
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("—");

    setTime(win, "endTime", "11:00");
    setTime(win, "startTime", ""); // start missing — cleared too
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("—");
    win.close();
  });

  test("only lets a session be logged inside its window", async () => {
    const { win } = loadLogHours({});
    await flush();

    const doc = win.document;
    // The stub answers for the real clock, so pin the window state.
    win.__status = "early";
    win.__blockMessage =
      "You can only log a session while it's happening — logging opens at 09:00.";

    doc.querySelector(".course-chip").click();
    // Locked sessions say so on the chip itself.
    expect(
      doc.querySelector(".session-chip").classList.contains("is-locked"),
    ).toBe(true);

    doc.querySelector(".session-chip").click();

    // Picking a not-yet-open session explains why straight away…
    const formError = doc.getElementById("form-error");
    expect(formError.hidden).toBe(false);
    expect(formError.textContent).toBe(win.__blockMessage);

    // …and submitting is refused with the same reason, no round-trip.
    submitForm(win);
    await flush();
    expect(win.__added).toHaveLength(0);
    expect(win.__duplicateQueries).toHaveLength(0);
    expect(formError.textContent).toBe(win.__blockMessage);
    win.close();
  });

  test("logs a scheduled session, edits, and deletes entries", async () => {
    const { win } = loadLogHours({ entries: [ENTRY_E1, ENTRY_E2] });
    await flush();

    const doc = win.document;
    const monthTotal = doc.getElementById("month-total");
    const entriesBody = doc.getElementById("entries-body");
    const emptyState = doc.getElementById("empty-state");
    const toast = doc.getElementById("toast");

    // Initial render: both entries, rolled up into the month total.
    expect(win.__monthQueries).toEqual(["2026-09-01"]);
    expect(monthTotal.textContent).toBe("3.5");
    expect(doc.getElementById("month-label").textContent).not.toBe("");
    expect(entriesBody.querySelectorAll("tr")).toHaveLength(2);
    expect(emptyState.hidden).toBe(true);
    expect(entriesBody.querySelectorAll("tr")[0].children[1].textContent).toBe(
      "2h",
    );
    expect(entriesBody.querySelectorAll("tr")[1].children[4].textContent).toBe(
      "",
    ); // blank notes cell still rendered

    // Nothing can be logged before a scheduled session is picked.
    submitForm(win);
    const formError = doc.getElementById("form-error");
    expect(formError.textContent).toBe(
      "Pick one of the scheduled sessions first.",
    );
    expect(formError.hidden).toBe(false);

    // Pick the module, then one of its Wednesday sessions: the date and
    // times lock to that slot and the hours follow.
    doc.querySelector(".course-chip").click();
    expect(doc.getElementById("sessionStep").hidden).toBe(false);
    const sessionChips = doc.querySelectorAll(".session-chip");
    expect(sessionChips).toHaveLength(4); // the next four Wednesday slots
    expect(sessionChips[0].classList.contains("is-open")).toBe(true);
    sessionChips[0].click();

    const sessionDate = doc.getElementById("date").value;
    expect(sessionDate).not.toBe("");
    expect(doc.getElementById("startTime").value).toBe("09:00");
    expect(doc.getElementById("endTime").value).toBe("11:00");
    expect(doc.getElementById("hours").value).toBe("2");
    expect(doc.getElementById("attendanceCard").hidden).toBe(false);
    expect(doc.getElementById("scheduledBox").hidden).toBe(false);
    expect(doc.getElementById("scheduledVenue").textContent).toBe("MSB 101");
    expect(doc.getElementById("scheduledWhen").textContent).toContain(
      "09:00–11:00",
    );
    expect(win.__scrollIntoViewCalls).toEqual([
      { behavior: "smooth", block: "nearest" },
    ]);

    // An overlapping entry: the duplicate check fires on submit.
    win.__duplicate = { id: "other" };
    submitForm(win);
    await flush();
    expect(formError.textContent).toBe(
      "This overlaps an entry you've already logged for this day.",
    );
    expect(win.__duplicateQueries[0]).toEqual([
      {
        date: sessionDate,
        hours: 2,
        startTime: "09:00",
        endTime: "11:00",
        taskType: "Tutoring",
        courseId: 3,
        notes: "",
      },
      null,
    ]);

    // No duplicate: the entry is added — notes trimmed, module kept.
    win.__duplicate = null;
    doc.getElementById("notes").value = " some notes ";
    submitForm(win);
    await flush();
    expect(win.__added).toEqual([
      {
        date: sessionDate,
        hours: 2,
        startTime: "09:00",
        endTime: "11:00",
        taskType: "Tutoring",
        courseId: 3,
        notes: "some notes",
      },
    ]);
    expect(doc.getElementById("form-title").textContent).toBe("Log your hours");
    expect(doc.getElementById("submit-btn").textContent).toBe("Add entry");
    expect(doc.getElementById("cancel-edit-btn").hidden).toBe(true);
    expect(toast.textContent).toBe("Entry added.");
    expect(toast.classList.contains("show")).toBe(true);
    expect(win.__monthQueries).toHaveLength(2);

    // Edit the first entry: the form fills from the stored values.
    const scrollCalls = [];
    win.scrollTo = (options) => scrollCalls.push(options);
    const editBtn = entriesBody
      .querySelectorAll("tr")[0]
      .querySelector(".btn-link");
    editBtn.click();
    await flush(); // enterEditMode awaits ensureCourseOption
    expect(doc.getElementById("entry-id").value).toBe("e1");
    expect(doc.getElementById("form-title").textContent).toBe("Edit entry");
    expect(doc.getElementById("submit-btn").textContent).toBe("Save changes");
    expect(doc.getElementById("cancel-edit-btn").hidden).toBe(false);
    expect(doc.getElementById("hours-display").textContent).toBe("2h");
    expect(scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);

    submitForm(win);
    await flush();
    expect(win.__updated).toEqual([
      {
        id: "e1",
        entry: {
          date: "2026-09-29",
          hours: 2,
          startTime: "09:00",
          endTime: "11:00",
          taskType: "Marking",
          courseId: 4,
          notes: "bring notes",
        },
      },
    ]);
    expect(win.__duplicateQueries.map((q) => q[1])).toEqual([null, null, "e1"]);
    expect(toast.textContent).toBe("Entry updated.");

    // Cancel restores the add-mode form.
    doc.getElementById("cancel-edit-btn").click();
    expect(doc.getElementById("form-title").textContent).toBe("Log your hours");

    // Delete: cancelling the confirm dialog keeps the entry…
    const dialog = doc.getElementById("confirm-modal");
    const deleteBtn = () =>
      entriesBody.querySelectorAll("tr")[0].querySelector(".btn-link--danger");
    deleteBtn().click();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(doc.getElementById("confirm-modal-message").textContent).toBe(
      "Delete this entry?",
    );
    doc.getElementById("confirm-modal-cancel-btn").click();
    await flush();
    expect(win.__deleted).toHaveLength(0);

    // …Escape dismissal does the same…
    deleteBtn().click();
    dialog.dispatchEvent(new win.Event("cancel"));
    await flush();
    expect(win.__deleted).toHaveLength(0);

    // …and confirming deletes and re-renders.
    deleteBtn().click();
    doc.getElementById("confirm-modal-confirm-btn").click();
    await flush();
    expect(win.__deleted).toEqual(["e1"]);
    expect(win.__monthQueries).toHaveLength(4);
    expect(toast.textContent).toBe("Entry deleted.");
    expect(toast.classList.contains("show")).toBe(true);
    win.close();
  });

  test("shows the empty state and navigates between months", async () => {
    const { win } = loadLogHours({ entries: [] });
    await flush();

    const doc = win.document;
    expect(doc.getElementById("empty-state").hidden).toBe(false);
    expect(doc.getElementById("entries-body").children).toHaveLength(0);
    expect(doc.getElementById("month-total").textContent).toBe("0");

    doc.getElementById("prev-month-btn").click();
    await flush();
    expect(win.__monthQueries).toEqual(["2026-09-01", "2026-08-01"]);

    doc.getElementById("next-month-btn").click();
    doc.getElementById("next-month-btn").click();
    await flush();
    expect(win.__monthQueries).toEqual([
      "2026-09-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(doc.getElementById("month-label").textContent).not.toBe("");
    win.close();
  });

  test("shows each entry's attendance-verification state in the month table", async () => {
    const { win } = loadLogHours({
      entries: [
        { ...ENTRY_E1, verificationStatus: "verified" },
        {
          ...ENTRY_E2,
          verificationStatus: "flagged",
          verificationNote: "The tutorial slot was covered by someone else",
        },
      ],
    });
    await flush();

    const pills = [...win.document.querySelectorAll("#entries-body tr")].map(
      (row) => row.querySelector(".status-pill"),
    );

    expect(pills[0].classList.contains("approved")).toBe(true);
    expect(pills[0].textContent).toBe("Verified");
    expect(pills[1].classList.contains("rejected")).toBe(true);
    expect(pills[1].textContent).toBe("Flagged");
    // The organiser's reason for flagging rides along as the pill's tooltip.
    expect(pills[1].title).toBe(
      "The tutorial slot was covered by someone else",
    );
    win.close();
  });

  test("defaults entries logged before verification existed to Pending", async () => {
    const { win } = loadLogHours({ entries: [ENTRY_E1] });
    await flush();

    const pill = win.document.querySelector("#entries-body .status-pill");
    expect(pill.classList.contains("pending")).toBe(true);
    expect(pill.textContent).toBe("Pending");
    win.close();
  });

  test("jumps to a highlighted entry's month and flashes its row", async () => {
    const august = { ...ENTRY_E1, id: "e3", date: "2026-08-12" };
    const { win } = loadLogHours({
      entries: [ENTRY_E1, august],
      highlightEntry: "e3",
    });
    await flush();

    const row = win.document.querySelector('tr[data-entry-id="e3"]');
    expect(row).not.toBeNull();
    expect(row.classList.contains("highlight-flash")).toBe(true);
    expect(win.__highlighted).toBe("e3");
    // The page jumped from the current month to the entry's own month first.
    expect(win.__monthQueries).toEqual(["2026-09-01", "2026-08-01"]);
    win.close();
  });
});
