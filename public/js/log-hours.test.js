// log-hours.js is the tutor/student "log your hours" page module. The
// real nav.js/storage.js imports can't load here (they fetch the API), so
// both import statements are stripped and their functions are replaced by
// stubs appended after the real source — in the one eval scope, the later
// function declarations win. Everything else (role-based nav tweaks,
// hours-from-times math, the confirm dialog wrapper, week navigation, and
// the whole submit/edit/delete flow) is the real code running inside
// jsdom, with the //# sourceURL tag so Jest's v8 coverage attributes the
// lines back to the real file.
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
function getCurrentUser() {
  return window.__user;
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
function getWeekStart(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate());
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate());
}
function getEntriesForWeek(weekStart) {
  window.__weekQueries.push(weekStart);
  return Promise.resolve(window.__entries);
}
function todayStr() {
  return window.__today;
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
    <h2 id="form-title">Log hours</h2>
    <form id="entry-form">
      <input type="hidden" id="entry-id">
      <input type="hidden" id="hours">
      <input type="date" id="date">
      <select id="taskType">
        <option value="Tutoring">Tutoring</option>
        <option value="Marking">Marking</option>
      </select>
      <input type="time" id="startTime">
      <input type="time" id="endTime">
      <p id="form-error" hidden></p>
      <input type="text" id="subject">
      <select id="courseSelect"><option value="">No specific course</option></select>
      <p id="hours-display">—</p>
      <textarea id="notes"></textarea>
      <button type="submit" id="submit-btn">Add entry</button>
      <button type="button" id="cancel-edit-btn" hidden>Cancel</button>
    </form>
    <button type="button" id="prev-week-btn"></button>
    <span id="week-label"></span>
    <button type="button" id="next-week-btn"></button>
    <p>Total this week: <strong id="week-total">0</strong> hours</p>
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

const COURSES = [
  { id: "3", course_code: "COMS1015A", course_name: "Computer Science 1A" },
  { id: "4", course_code: "MATH1000", course_name: "Intro Maths" },
];

const ENTRY_E1 = {
  id: "e1",
  date: "2026-09-29",
  hours: 2,
  startTime: "09:00",
  endTime: "11:00",
  taskType: "Marking",
  subject: "PHYS1000",
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
  subject: "COMS1015A",
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
  coursesRespond = () => jsonResponse(COURSES),
} = {}) {
  // The redirect on the not-logged-in path is jsdom's "Not implemented:
  // navigation" — swallow it through a quiet virtual console.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  const logHoursJs = rawLogHoursJs
    .replace(/import\s*{[^}]*}\s*from\s*["']\.\/nav\.js["'];?/, "")
    .replace(/import\s*{[\s\S]*?}\s*from\s*["']\.\/storage\.js["'];?/, "")
    // Top-level await only works in a module; a classic script (which is
    // what jsdom executes) needs the bare call. Everything else the page
    // awaits sits inside async functions, so this is the only change.
    .replace(/\nawait render\(\);\s*$/, "\nrender();");

  const courseFetches = [];

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
      window.__user = user;
      window.__today = "2026-09-30"; // a Wednesday
      window.__entries = entries;
      window.__duplicate = null;
      window.__added = [];
      window.__updated = [];
      window.__deleted = [];
      window.__weekQueries = [];
      window.__duplicateQueries = [];
      window.fetch = (url) => {
        courseFetches.push(String(url));
        return coursesRespond(String(url));
      };
    },
  });

  try {
    dom.window.eval(
      `${logHoursJs}\n${STUBS}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "log-hours.js")).href}`,
    );
  } catch (err) {
    // The not-logged-in path throws by design after redirecting.
  }

  return { win: dom.window, courseFetches };
}

// Types a value into one of the time fields, firing the "input" event the
// page listens on to recompute the hours figure.
function setTime(win, id, value) {
  const field = win.document.getElementById(id);
  field.value = value;
  field.dispatchEvent(new win.Event("input", { bubbles: true }));
}

describe("log-hours.js", () => {
  test("redirects away when nobody is signed in", () => {
    const { win } = loadLogHours({ user: null });

    expect(win.__weekQueries).toHaveLength(0); // render() never ran
    expect(win.__added).toHaveLength(0);
    win.close();
  });

  test("role-based nav targets and course options", async () => {
    const { win, courseFetches } = loadLogHours({});
    await flush();

    const doc = win.document;
    expect(courseFetches).toEqual(["/api/courses"]);
    const options = doc.getElementById("courseSelect").options;
    expect(options).toHaveLength(3);
    expect(options[1].textContent).toBe("COMS1015A — Computer Science 1A");
    expect(options[2].value).toBe("4");

    // Tutor: student-only links hidden, profile link kept.
    expect(doc.getElementById("my-sessions-nav-link").hidden).toBe(true);
    expect(doc.getElementById("profile-nav-link").hidden).toBe(false);
    expect(doc.getElementById("dashboard-nav-link").getAttribute("href")).toBe(
      "dashboard.html",
    );
    win.close();
  });

  test("student and organiser nav variants", async () => {
    const student = loadLogHours({
      user: { id: "s1", name: "Student One", role: "student" },
      // A non-ok courses response: the picker quietly stays empty.
      coursesRespond: () => jsonResponse({ error: "nope" }, false),
    });
    await flush();
    const studentDoc = student.win.document;
    expect(
      studentDoc.getElementById("dashboard-nav-link").getAttribute("href"),
    ).toBe("StudentView.html");
    expect(
      studentDoc.getElementById("calendar-nav-link").getAttribute("href"),
    ).toBe("student-calendar.html");
    expect(
      studentDoc.getElementById("profile-nav-link").getAttribute("href"),
    ).toBe("student-profile.html");
    expect(studentDoc.getElementById("timesheets-nav-link").hidden).toBe(true);
    expect(studentDoc.getElementById("modules-nav-link").hidden).toBe(true);
    expect(studentDoc.getElementById("courseSelect").options).toHaveLength(1);

    const organiser = loadLogHours({
      user: { id: "o1", name: "Organiser One", role: "organiser" },
      // A rejected fetch: also quietly ignored.
      coursesRespond: () => Promise.reject(new Error("offline")),
    });
    await flush();
    const organiserDoc = organiser.win.document;
    expect(organiserDoc.getElementById("my-sessions-nav-link").hidden).toBe(
      true,
    );
    expect(organiserDoc.getElementById("profile-nav-link").hidden).toBe(true);
    expect(
      organiserDoc.getElementById("dashboard-nav-link").getAttribute("href"),
    ).toBe("dashboard.html");
    student.win.close();
    organiser.win.close();
  });

  test("recomputes hours from start/end times", async () => {
    const { win } = loadLogHours({});
    await flush();

    const doc = win.document;
    const hoursField = doc.getElementById("hours");
    const display = doc.getElementById("hours-display");

    setTime(win, "startTime", "09:00");
    setTime(win, "endTime", "09:20"); // rounds to 0 — too short to log
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("Too short to log (rounds to 0 hours)");

    setTime(win, "endTime", "08:00"); // not after the start — left alone
    expect(display.textContent).toBe("Too short to log (rounds to 0 hours)");

    setTime(win, "endTime", "10:20"); // 80 minutes → 1 hour
    expect(hoursField.value).toBe("1");

    setTime(win, "endTime", "11:00"); // 2 hours
    expect(hoursField.value).toBe("2");
    expect(display.textContent).toBe("2");

    setTime(win, "endTime", ""); // incomplete range — cleared
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("—");

    setTime(win, "endTime", "11:00");
    setTime(win, "startTime", ""); // start missing — cleared too
    expect(hoursField.value).toBe("");
    expect(display.textContent).toBe("—");
    win.close();
  });

  test("renders the week, logs, edits, and deletes entries", async () => {
    const { win } = loadLogHours({ entries: [ENTRY_E1, ENTRY_E2] });
    await flush();

    const doc = win.document;
    const weekTotal = doc.getElementById("week-total");
    const entriesBody = doc.getElementById("entries-body");
    const emptyState = doc.getElementById("empty-state");
    const toast = doc.getElementById("toast");

    // Initial render: both entries, week starts on the Monday.
    expect(win.__weekQueries).toEqual(["2026-09-28"]);
    expect(weekTotal.textContent).toBe("3.5");
    expect(doc.getElementById("week-label").textContent).not.toBe("");
    expect(entriesBody.querySelectorAll("tr")).toHaveLength(2);
    expect(emptyState.hidden).toBe(true);
    expect(entriesBody.querySelectorAll("tr")[1].children[4].textContent).toBe(
      "",
    ); // blank notes cell still rendered

    // Submitting without a valid time range is rejected up front.
    doc
      .getElementById("entry-form")
      .dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
    const formError = doc.getElementById("form-error");
    expect(formError.textContent).toBe(
      "Enter a start and end time that add up to at least one whole hour.",
    );
    expect(formError.hidden).toBe(false);

    // Fill a valid range and an overlapping entry: duplicate check fires.
    setTime(win, "startTime", "09:00");
    setTime(win, "endTime", "11:00");
    doc.getElementById("subject").value = " COMS1015A ";
    win.__duplicate = { id: "other" };
    doc
      .getElementById("entry-form")
      .dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
    await flush();
    expect(formError.textContent).toBe(
      "This overlaps an entry you've already logged for this day.",
    );
    expect(win.__duplicateQueries[0]).toEqual([
      {
        date: "2026-09-30",
        hours: 2,
        startTime: "09:00",
        endTime: "11:00",
        taskType: "Tutoring",
        subject: "COMS1015A",
        courseId: null,
        notes: "",
      },
      null,
    ]);

    // No duplicate: the entry is added, with the picked course and
    // trimmed notes.
    win.__duplicate = null;
    doc.getElementById("courseSelect").value = "3";
    doc.getElementById("notes").value = " some notes ";
    doc
      .getElementById("entry-form")
      .dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
    await flush();
    expect(win.__added).toEqual([
      {
        date: "2026-09-30",
        hours: 2,
        startTime: "09:00",
        endTime: "11:00",
        taskType: "Tutoring",
        subject: "COMS1015A",
        courseId: 3,
        notes: "some notes",
      },
    ]);
    expect(doc.getElementById("form-title").textContent).toBe("Log hours");
    expect(doc.getElementById("submit-btn").textContent).toBe("Add entry");
    expect(doc.getElementById("cancel-edit-btn").hidden).toBe(true);
    expect(toast.textContent).toBe("Entry added.");
    expect(toast.classList.contains("toast--success")).toBe(true);
    expect(win.__weekQueries).toHaveLength(2);

    // Edit the first entry: the form fills from the stored values.
    const scrollCalls = [];
    win.scrollTo = (options) => scrollCalls.push(options);
    const editBtn = entriesBody
      .querySelectorAll("tr")[0]
      .querySelector(".btn-link");
    editBtn.click();
    expect(doc.getElementById("entry-id").value).toBe("e1");
    expect(doc.getElementById("form-title").textContent).toBe("Edit entry");
    expect(doc.getElementById("submit-btn").textContent).toBe("Save changes");
    expect(doc.getElementById("cancel-edit-btn").hidden).toBe(false);
    expect(doc.getElementById("hours-display").textContent).toBe("2");
    expect(scrollCalls).toEqual([{ top: 0, behavior: "smooth" }]);

    doc
      .getElementById("entry-form")
      .dispatchEvent(
        new win.Event("submit", { bubbles: true, cancelable: true }),
      );
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
          subject: "PHYS1000",
          courseId: 4,
          notes: "bring notes",
        },
      },
    ]);
    expect(win.__duplicateQueries.map((q) => q[1])).toEqual([null, null, "e1"]);
    expect(toast.textContent).toBe("Entry updated.");

    // Cancel restores the add-mode form.
    doc.getElementById("cancel-edit-btn").click();
    expect(doc.getElementById("form-title").textContent).toBe("Log hours");

    // Delete: cancelling the confirm dialog keeps the entry…
    const dialog = doc.getElementById("confirm-modal");
    entriesBody.querySelectorAll("tr")[0].querySelector(".btn-danger").click();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(doc.getElementById("confirm-modal-message").textContent).toBe(
      "Delete this entry?",
    );
    doc.getElementById("confirm-modal-cancel-btn").click();
    expect(win.__deleted).toHaveLength(0);

    // …Escape dismissal does the same…
    entriesBody.querySelectorAll("tr")[0].querySelector(".btn-danger").click();
    dialog.dispatchEvent(new win.Event("cancel"));
    expect(win.__deleted).toHaveLength(0);

    // …and confirming deletes and re-renders.
    entriesBody.querySelectorAll("tr")[0].querySelector(".btn-danger").click();
    doc.getElementById("confirm-modal-confirm-btn").click();
    await flush();
    expect(win.__deleted).toEqual(["e1"]);
    expect(win.__weekQueries).toHaveLength(4);
    expect(toast.textContent).toBe("Entry deleted.");
    expect(toast.classList.contains("toast--danger")).toBe(true);
    win.close();
  });

  test("shows the empty state and navigates between weeks", async () => {
    const { win } = loadLogHours({ entries: [] });
    await flush();

    const doc = win.document;
    expect(doc.getElementById("empty-state").hidden).toBe(false);
    expect(doc.getElementById("entries-body").children).toHaveLength(0);
    expect(doc.getElementById("week-total").textContent).toBe("0");

    doc.getElementById("prev-week-btn").click();
    await flush();
    expect(win.__weekQueries).toEqual(["2026-09-28", "2026-09-21"]);

    doc.getElementById("next-week-btn").click();
    doc.getElementById("next-week-btn").click();
    await flush();
    expect(win.__weekQueries).toEqual([
      "2026-09-28",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(doc.getElementById("week-label").textContent).not.toBe("");
    win.close();
  });
});
