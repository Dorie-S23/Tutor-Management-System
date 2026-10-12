// board.js flows the drafts / keyboard-nav / sync-status / transcript suites
// don't reach: the load-and-render path (rail, stats, budget, side panels),
// the applications pane with its reason/override modals, session excusals and
// cover assignment, volunteer decisions, overflow sessions, diagonals,
// obvious fill, whole-school auto-allocate, the add/edit/delete course modals,
// the locked-course access-request flow, and the ?course= deep link.
//
// Same real-page harness as board.drafts.test.js — board.html + the full
// board.js inlined into jsdom — with the fetch stub made configurable through
// window.__config so each test seeds its own data. The inlined source is the
// untouched file, exactly like the other board suites, so Jest's v8 coverage
// merges every suite's copy of board.js cleanly.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

jest.setTimeout(15000);

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
const allocationObjectivesJs = fs.readFileSync(
  path.join(__dirname, "allocation-objectives.js"),
  "utf8",
);

const openDoms = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 8) {
  for (let i = 0; i < times; i++) await flush();
}

let requests; // every fetch the page makes: { url, method, body }
let currentWindow = null; // most recent loadBoard() window — toasts read from it
const notify = () => currentWindow.document.getElementById("toast").textContent;

const DEFAULT_USER = {
  id: "org-1",
  name: "Olive Organiser",
  role: "organiser",
};

function courseRow(overrides = {}) {
  return {
    id: 1,
    course_code: "COMS1010A",
    course_name: "Intro to Algorithms",
    min_mark: 60,
    course_level: 4, // "honours" — the edit modal's prefill uses COURSE_LEVEL_LABELS
    department: "Computer Science",
    hours_per_week: 5,
    tutors_needed: 2,
    no_of_tutors_assigned: 1,
    budget: 500,
    Day_of_tut: "Thursday",
    tutor_start_time: "10:00:00",
    tutor_end_time: "12:00:00",
    venues: "MSL004",
    Day_of_lab: null,
    lab_start_time: null,
    lab_end_time: null,
    lab_venues: null,
    diagonal_count: 0,
    ...overrides,
  };
}

function course2Row(overrides = {}) {
  return courseRow({
    id: 2,
    course_code: "COMS2020B",
    course_name: "Data Structures",
    hours_per_week: 3,
    budget: 300,
    tutors_needed: 2,
    no_of_tutors_assigned: 2,
    Day_of_tut: null,
    tutor_start_time: null,
    tutor_end_time: null,
    venues: null,
    Day_of_lab: "Friday",
    lab_start_time: "14:00:00",
    lab_end_time: "16:00:00",
    lab_venues: "MSL010",
    ...overrides,
  });
}

// Local date parts, not toISOString — the UTC conversion shifts the
// result back a day during the first two hours after local midnight
// (SAST), which broke these fixtures on nightly CI runs.
function nextThursdayIso() {
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7 || 7));
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function loadBoard(config = {}, { user, url } = {}) {
  // Same sourceURL attribution as board.keyboard-nav.test.js — without it the
  // inlined source never lands on board.js's coverage numbers, and the line
  // layout must match the other suites' so their copies merge.
  const boardJsUrl = pathToFileURL(path.join(__dirname, "board.js")).href;
  const html = boardHtml
    .replace(
      '<script src="../js/allocation-objectives.js"></script>',
      `<script>${allocationObjectivesJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "allocation-objectives.js")).href}</script>`,
    )
    .replace(
      '<script src="../js/board.js"></script>',
      `<script>${boardJs}\n//# sourceURL=${boardJsUrl}\n</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: url || "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      requests = [];
      const deletedCourses = new Set(); // DELETE /api/courses/:id memory
      window.__config = config;
      window.confirm = () => true;
      window.sessionStorage.setItem(
        "user",
        JSON.stringify(user || DEFAULT_USER),
      );
      // jsdom doesn't implement the <dialog> open/close methods board.js
      // leans on, so give them the browser's observable behaviour.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        window.HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
      }
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
      window.fetch = async (url, options = {}) => {
        const u = String(url);
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ url: u, method, body });
        const ok = (data) =>
          Promise.resolve({ ok: true, status: 200, json: async () => data });
        const fail = (status, data) =>
          Promise.resolve({ ok: false, status, json: async () => data });
        const cfg = window.__config;

        if (u.startsWith("/api/course-volunteers/counts")) {
          return ok(
            u.includes("status=pending")
              ? cfg.pendingVolunteerCounts || {}
              : cfg.volunteerCounts || {},
          );
        }
        if (u === "/api/courses" && method === "GET") {
          return ok(
            (cfg.courses || []).filter(
              (c) => !deletedCourses.has(Number(c.id)),
            ),
          );
        }
        if (u === "/api/courses" && method === "POST") {
          return ok({ course_code: body.course_code });
        }
        const courseMatch = u.match(/^\/api\/courses\/(\d+)$/);
        if (courseMatch && method === "PUT") {
          return ok({ course_code: body.course_code });
        }
        if (courseMatch && method === "DELETE") {
          if (cfg.deleteCourseFails) {
            return fail(400, { error: "course still has assigned tutors" });
          }
          deletedCourses.add(Number(courseMatch[1]));
          return ok({});
        }
        if (/^\/api\/courses\/\d+\/diagonals$/.test(u)) {
          return ok(
            cfg.diagonals || {
              diagonals: [],
              unassigned: { tutors: [], volunteers: [] },
            },
          );
        }
        if (/^\/api\/courses\/\d+\/diagonals\/members$/.test(u)) return ok({});
        if (/^\/api\/courses\/\d+\/diagonals\/split$/.test(u)) return ok({});
        if (u === "/api/tutors") return ok(cfg.tutors || []);
        if (u === "/api/tutors/workload") return ok(cfg.workload || []);
        if (/^\/api\/tutors\/[^/]+\/assignment-check/.test(u)) {
          return ok(
            cfg.assignmentCheck || {
              clashes: { busyTimeClashes: [], courseClashes: [] },
              workload: { weeklyHourCap: 6, projectedHours: 4, overCap: false },
            },
          );
        }
        if (u.startsWith("/api/tutor-applications/obvious-fill")) {
          return cfg.obviousFillFails
            ? fail(500, { error: "boom" })
            : ok(cfg.obviousFill || []);
        }
        if (u === "/api/tutor-applications/bulk-approve") {
          return ok({ results: [{ success: true }, { success: false }] });
        }
        const appLock = u.match(/^\/api\/tutor-applications\/([^/]+)\/lock$/);
        if (appLock) return ok({});
        const appMatch = u.match(/^\/api\/tutor-applications\/([^/?]+)$/);
        if (appMatch && method === "PATCH") {
          return cfg.statusChangeFails
            ? fail(409, { error: "changed elsewhere" })
            : ok({});
        }
        const appList = u.match(/^\/api\/tutor-applications\?courseId=(\d+)/);
        if (appList) {
          return ok((cfg.applicationsByCourse || {})[appList[1]] || []);
        }
        const findCover = u.match(
          /^\/api\/session-excusals\/([^/]+)\/find-cover$/,
        );
        if (findCover) return ok({ cover: { name: "Vinnie V" } });
        if (u.startsWith("/api/session-excusals")) {
          return ok(cfg.excusals || []);
        }
        if (u === "/api/course-volunteers" && method === "POST") return ok({});
        const volLock = u.match(/^\/api\/course-volunteers\/([^/]+)\/lock$/);
        if (volLock) return ok({});
        const volMatch = u.match(/^\/api\/course-volunteers\/([^/?]+)$/);
        if (volMatch && method === "PATCH") return ok({});
        if (u.startsWith("/api/course-volunteers")) {
          return ok(cfg.volunteers || []);
        }
        if (u === "/api/allocation-drafts/auto-allocate") {
          return ok(
            cfg.autoAllocate || { draft: null, assignments: [], skipped: [] },
          );
        }
        const publish = u.match(/^\/api\/allocation-drafts\/(\d+)\/publish$/);
        if (publish) {
          return ok({
            draft: { id: Number(publish[1]) },
            results: [{ success: true }],
          });
        }
        if (u === "/api/organiser-requests" && method === "POST") {
          return cfg.accessRequestConflict
            ? fail(409, { status: "pending", error: "already requested" })
            : ok({});
        }
        if (u.startsWith("/api/organiser-requests/mine")) {
          return ok(cfg.accessRequests || []);
        }
        if (/^\/api\/transcripts\/[^/]+\/signed-url$/.test(u)) {
          return cfg.transcriptUrl
            ? ok({ url: cfg.transcriptUrl })
            : fail(404, {});
        }
        return ok([]);
      };
    },
  });

  openDoms.push(dom);
  currentWindow = dom.window;
  return dom.window;
}

afterEach(() => {
  openDoms.splice(0).forEach((dom) => dom.window.close());
});

// ---------- load, rail, stats and side panels ----------

describe("board.js — load, rail and side panels", () => {
  test("courses load into the rail with statuses, stats, budget and attention panels", async () => {
    const window = loadBoard({
      courses: [courseRow(), course2Row()],
      tutors: [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
      volunteerCounts: { 1: 4 },
      pendingVolunteerCounts: { 2: 3 },
      applicationsByCourse: {
        1: [
          {
            id: 33,
            tutor_id: "t8",
            status: "approved",
            tutor_mark: 70,
            Availability: true,
            tutors: { name: "Ann A", hourly_rate: 120 },
          },
        ],
        2: [],
      },
      workload: [
        { name: "Ben B", assignedHours: 9, courses: [] },
        { name: "Ann A", assignedHours: 3, courses: [] },
      ],
    });
    await settle();

    expect(window.document.getElementById("railCount").textContent).toBe("2");
    expect(window.document.getElementById("statFilled").textContent).toBe(
      "1 / 2",
    );
    expect(window.document.getElementById("statTutors").textContent).toBe("3");
    expect(window.document.getElementById("statPending").textContent).toBe("3");
    expect(
      window.document
        .getElementById("statPending")
        .classList.contains("stat-value--attention"),
    ).toBe(true);

    const cards = window.document.querySelectorAll(".course-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector(".course-card__code").textContent).toBe(
      "COMS1010A",
    );
    expect(cards[0].querySelector(".course-card__status").textContent).toBe(
      "Needs tutors",
    );
    expect(cards[0].querySelector(".course-card__meta").textContent).toBe(
      "4 volunteered",
    );
    expect(cards[0].querySelector(".course-card__fill").textContent).toBe(
      "1 / 2",
    );
    expect(cards[1].querySelector(".course-card__status").textContent).toBe(
      "Staffed",
    );
    expect(cards[1].querySelector(".course-card__pills").textContent).toContain(
      "3 to review",
    );

    // Weekly budget: R600 planned (120 × 5h) against an R800 cap.
    expect(window.document.getElementById("statBudget").textContent).toBe(
      "75%",
    );
    expect(window.document.getElementById("weekBudgetUsed").textContent).toBe(
      "R600",
    );
    expect(window.document.getElementById("weekBudgetTotal").textContent).toBe(
      "of R800",
    );
    expect(window.document.getElementById("weekBudgetNote").textContent).toBe(
      "R200 remaining this week.",
    );

    // Tutor load, sorted heaviest first, over-cap flagged.
    const loadItems = window.document.querySelectorAll(
      "#tutorLoadList .load-item",
    );
    expect(loadItems).toHaveLength(2);
    expect(loadItems[0].querySelector(".load-item__name").textContent).toBe(
      "Ben B",
    );
    expect(loadItems[0].querySelector(".load-item__hours").textContent).toBe(
      "9/6h",
    );
    expect(
      loadItems[0]
        .querySelector(".load-item__fill")
        .classList.contains("load-item__fill--over"),
    ).toBe(true);

    const attention = Array.from(
      window.document.querySelectorAll("#attentionList li"),
    ).map((li) => li.textContent);
    expect(attention).toHaveLength(3);
    expect(attention[0]).toContain("1 course is still understaffed");
    expect(attention[1]).toContain("3 decisions waiting on applications");
    expect(attention[2]).toContain("1 tutor is over their weekly hour cap");
  });

  test("search filters the rail and the shortfall toggle hides staffed courses", async () => {
    const window = loadBoard({
      courses: [courseRow(), course2Row()],
    });
    await settle();

    const search = window.document.getElementById("courseSearch");
    search.value = "2020";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    expect(window.document.querySelectorAll(".course-card")).toHaveLength(1);
    expect(
      window.document.querySelector(".course-card__code").textContent,
    ).toBe("COMS2020B");

    search.value = "Algorithms";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    await settle();
    expect(
      window.document.querySelector(".course-card__code").textContent,
    ).toBe("COMS1010A");

    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const toggle = window.document.getElementById("shortfallToggle");
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    // Only the understaffed course survives the shortfall filter.
    expect(window.document.querySelectorAll(".course-card")).toHaveLength(1);
    expect(
      window.document.querySelector(".course-card__code").textContent,
    ).toBe("COMS1010A");
  });

  test("selecting a course renders the detail pane and assignment card", async () => {
    const window = loadBoard({
      courses: [courseRow()],
      volunteerCounts: { 1: 4 },
      applicationsByCourse: {
        1: [
          {
            id: 33,
            tutor_id: "t8",
            status: "approved",
            tutor_mark: 70,
            Availability: true,
            tutors: { name: "Ann A", hourly_rate: 120 },
          },
        ],
      },
    });
    await settle();

    window.document.querySelector('.course-card[data-course-id="1"]').click();
    await settle();

    expect(window.document.getElementById("emptyState").hidden).toBe(true);
    expect(window.document.getElementById("dCode").textContent).toBe(
      "COMS1010A",
    );
    expect(window.document.getElementById("dSession").textContent).toContain(
      "Tutorial Thursday 10:00–12:00 (MSL004)",
    );
    expect(window.document.getElementById("dSession").textContent).toContain(
      "requires a mark of 60+",
    );
    expect(window.document.getElementById("dHours").textContent).toBe("5");
    expect(window.document.getElementById("dMinMark").textContent).toBe("60%");
    expect(window.document.getElementById("dTutorsAssigned").textContent).toBe(
      "1 / 2",
    );
    expect(window.document.getElementById("dVolunteered").textContent).toBe(
      "4",
    );
    expect(window.document.getElementById("dBudget").textContent).toBe(
      "R500.00",
    );

    const card = window.document.getElementById("assignmentCard");
    expect(card.querySelector(".tutor-chip").textContent).toContain("Ann A");
    expect(card.textContent).toContain("1 slot still open");
  });

  test("arrow keys walk the course rail and focus follows the selection", async () => {
    const window = loadBoard({
      courses: [courseRow(), course2Row()],
    });
    await settle();

    const press = (key) =>
      window.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, cancelable: true }),
      );

    press("ArrowDown");
    await settle();
    expect(
      window.document
        .querySelector('.course-card[data-course-id="1"]')
        .classList.contains("active"),
    ).toBe(true);

    press("ArrowDown");
    await settle();
    const second = window.document.querySelector(
      '.course-card[data-course-id="2"]',
    );
    expect(second.classList.contains("active")).toBe(true);
    expect(window.document.activeElement).toBe(second);

    press("Home");
    await settle();
    expect(
      window.document
        .querySelector('.course-card[data-course-id="1"]')
        .classList.contains("active"),
    ).toBe(true);

    press("End");
    await settle();
    expect(
      window.document
        .querySelector('.course-card[data-course-id="2"]')
        .classList.contains("active"),
    ).toBe(true);
  });
});

// ---------- applications pane ----------

describe("board.js — applications pane", () => {
  const twoRows = {
    courses: [courseRow()],
    applicationsByCourse: {
      1: [
        {
          id: 31,
          tutor_id: "t9",
          status: "pending",
          tutor_mark: 75,
          Availability: true,
          tutors: {
            name: "Tim T",
            academic_level: "third_year",
            hourly_rate: 110,
          },
          ranking: { score: 87.4, meritRank: 1, paretoDominated: false },
        },
        {
          id: 32,
          tutor_id: "t8",
          status: "rejected",
          locked: true,
          tutor_mark: 50,
          Availability: false,
          tutors: { name: "Rex R", academic_level: "second_year" },
        },
      ],
    },
  };

  test("applicant rows render stamps from assignment checks and rankings", async () => {
    const window = loadBoard(
      { ...twoRows },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    expect(window.document.getElementById("applicantsCount").textContent).toBe(
      "2",
    );
    const rows = window.document.querySelectorAll("#applicantList .tutor-row");
    expect(rows).toHaveLength(2);

    const stamps = rows[0].querySelector(".stamp-row").textContent;
    expect(stamps).toContain("Score 87");
    expect(stamps).toContain("Mark 75");
    expect(stamps).toContain("Free at tutorial time");
    expect(stamps).toContain("No timetable clashes");
    expect(stamps).toContain("4/6 hrs/wk");
    expect(stamps).toContain("No better all-round option");
    expect(rows[0].querySelector(".role").textContent).toBe("3rd year");
    expect(rows[0].querySelector(".status-pill").textContent).toBe("pending");

    // A locked rejection shows its stamp instead of decisions.
    expect(rows[1].querySelector(".status-pill").textContent).toBe("rejected");
    const rexActions = Array.from(
      rows[1].querySelectorAll(".applicant-actions .btn-small"),
    ).map((b) => b.textContent);
    expect(rexActions).toEqual(["Transcript"]);
    expect(rows[1].textContent).toContain("Locked");
  });

  test("approve goes through the reason modal and PATCHes with the note", async () => {
    const window = loadBoard(
      { ...twoRows },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    const approveBtn = window.document.querySelector(
      "#applicantList .btn-small.approve",
    );
    approveBtn.click();
    await settle();

    const modal = window.document.getElementById("reasonModal");
    expect(modal.open).toBe(true);
    expect(window.document.getElementById("reasonHeading").textContent).toBe(
      "Approve Tim T for COMS1010A?",
    );

    // Empty reason is rejected inline. (The textarea is required, so a real
    // submit would be blocked by native validation — drive the JS guard
    // directly instead.)
    window.document
      .getElementById("reasonForm")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await settle();
    expect(window.document.getElementById("reasonError").hidden).toBe(false);
    expect(window.document.getElementById("reasonError").textContent).toBe(
      "A reason is required.",
    );
    expect(
      requests.some(
        (r) => r.method === "PATCH" && /tutor-applications\/31$/.test(r.url),
      ),
    ).toBe(false);

    window.document.getElementById("reasonInput").value = "Strong mark";
    window.document.getElementById("reasonForm").requestSubmit();
    await settle();

    expect(modal.open).toBe(false);
    const patch = requests.find(
      (r) => r.method === "PATCH" && /tutor-applications\/31$/.test(r.url),
    );
    expect(patch.body).toMatchObject({
      status: "approved",
      approvalReason: "Strong mark",
      expectedStatus: "pending",
    });
    expect(notify()).toBe("Tim T assigned to COMS1010A");
  });

  test("reject asks for a reason and PATCHes rejected", async () => {
    // Make the pending row rejectable again by unlocking Rex's row is not
    // needed — reject lives on the pending row.
    const window = loadBoard(
      { ...twoRows },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    window.document.querySelector("#applicantList .btn-small.reject").click();
    await settle();
    expect(window.document.getElementById("reasonHeading").textContent).toBe(
      "Reject Tim T's application?",
    );
    window.document.getElementById("reasonInput").value = "Below minimum";
    window.document.getElementById("reasonForm").requestSubmit();
    await settle();

    const patch = requests.find(
      (r) => r.method === "PATCH" && /tutor-applications\/31$/.test(r.url),
    );
    expect(patch.body).toMatchObject({
      status: "rejected",
      rejectionReason: "Below minimum",
    });
    expect(notify()).toBe("Tim T's application rejected");
  });

  test("a full course disables Approve and the override modal PATCHes with a reason", async () => {
    const window = loadBoard(
      {
        courses: [courseRow({ tutors_needed: 1, no_of_tutors_assigned: 1 })],
        applicationsByCourse: {
          1: [
            {
              id: 31,
              tutor_id: "t9",
              status: "pending",
              tutor_mark: 75,
              Availability: true,
              tutors: { name: "Tim T", academic_level: "third_year" },
            },
          ],
        },
      },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    const approveBtn = window.document.querySelector(
      "#applicantList .btn-small.approve",
    );
    expect(approveBtn.disabled).toBe(true);
    expect(approveBtn.title).toBe(
      "This course already has all the tutors it needs",
    );

    window.document.querySelector("#applicantList .btn-small.override").click();
    await settle();
    const modal = window.document.getElementById("overrideModal");
    expect(modal.open).toBe(true);
    expect(
      window.document.getElementById("overrideModalContext").textContent,
    ).toContain("already has all the tutors it needs");

    window.document.getElementById("overrideReasonInput").value =
      "Needed for the practical";
    window.document.getElementById("overrideForm").requestSubmit();
    await settle();

    expect(modal.open).toBe(false);
    const patch = requests.find(
      (r) => r.method === "PATCH" && /tutor-applications\/31$/.test(r.url),
    );
    expect(patch.body).toMatchObject({
      status: "approved",
      override: true,
      organiserId: "org-1",
      reason: "Needed for the practical",
      approvalReason: "Needed for the practical",
      expectedStatus: "pending",
    });
    expect(notify()).toBe("Tim T approved for COMS1010A (override recorded)");
  });

  test("approved rows offer unassign and confirm-gated lock", async () => {
    const window = loadBoard(
      {
        courses: [courseRow()],
        applicationsByCourse: {
          1: [
            {
              id: 33,
              tutor_id: "t8",
              status: "approved",
              tutor_mark: 70,
              Availability: true,
              tutors: { name: "Ann A", hourly_rate: 120 },
            },
          ],
        },
      },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    const row = window.document.querySelector("#applicantList .tutor-row");
    const buttons = Array.from(
      row.querySelectorAll(".applicant-actions .btn-small"),
    );
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Unassign",
      "Lock",
      "Transcript",
    ]);

    buttons[0].click();
    await settle();
    expect(
      requests.find((r) => /tutor-applications\/33$/.test(r.url)).body,
    ).toMatchObject({ status: "pending", expectedStatus: "approved" });
    expect(notify()).toBe("Ann A moved back to pending");

    // The list re-rendered from the refetch — lock from the fresh DOM.
    const lockBtn = Array.from(
      window.document
        .querySelector("#applicantList .tutor-row")
        .querySelectorAll(".applicant-actions .btn-small"),
    ).find((b) => b.textContent === "Lock");
    lockBtn.click();
    await settle();
    expect(
      requests.find((r) => /tutor-applications\/33\/lock$/.test(r.url)).body,
    ).toEqual({ locked: true });
    expect(notify()).toBe("Ann A's assignment for COMS1010A is now locked.");
  });
});

// ---------- excusals, volunteers, overflow sessions ----------

describe("board.js — session excusals", () => {
  test("excusal rows show cover state and find-cover reassigns (with confirm when covered)", async () => {
    const soon = nextThursdayIso();
    const past = "2020-01-01";
    const window = loadBoard(
      {
        courses: [courseRow()],
        excusals: [
          {
            id: 51,
            session_date: soon,
            session_type: "tutorial",
            reason: "Conference",
            tutors: { name: "Tessa T" },
            cover: null,
          },
          {
            id: 52,
            session_date: soon,
            session_type: "tutorial",
            reason: "Sick",
            tutors: { name: "Nora N" },
            cover: { name: "Vinnie V" },
            swap_to_user_id: "u5",
            swap_to: { name: "Sam S" },
          },
          {
            id: 53,
            session_date: past,
            session_type: "tutorial",
            reason: "Long ago",
            tutors: { name: "Old O" },
          },
          {
            // Recorded before session_type existed — matched by weekday.
            id: 54,
            session_date: soon,
            reason: "Legacy",
            tutors: { name: "Lee L" },
          },
        ],
      },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    expect(window.document.getElementById("excusalsCount").textContent).toBe(
      "3",
    );
    const rows = window.document.querySelectorAll("#excusalList .tutor-row");
    expect(rows).toHaveLength(3);

    expect(rows[0].textContent).toContain("Tessa T");
    expect(rows[0].textContent).toContain("Conference");
    expect(rows[0].textContent).toContain("No cover");
    expect(rows[0].textContent).toContain("Tutorial");

    expect(rows[1].textContent).toContain("Covered by Vinnie V");
    expect(rows[1].textContent).toContain("Swap asked → Sam S");

    // Legacy excusal still lands on the Thursday tutorial slot.
    expect(rows[2].textContent).toContain("Lee L");
    expect(rows[2].textContent).toContain("Tutorial");

    const findCoverBtn = rows[0].querySelector(".applicant-actions .btn-small");
    expect(findCoverBtn.textContent).toBe("Find cover");
    findCoverBtn.click();
    await settle();
    expect(
      requests.find((r) => r.url.endsWith("/session-excusals/51/find-cover")),
    ).toBeDefined();
    expect(notify()).toContain("Vinnie V will cover Tessa T's session.");

    const reassignBtn = rows[1].querySelector(".applicant-actions .btn-small");
    expect(reassignBtn.textContent).toBe("Reassign");
    reassignBtn.click();
    await settle();
    expect(
      requests.find((r) => r.url.endsWith("/session-excusals/52/find-cover")),
    ).toBeDefined();
  });
});

describe("board.js — volunteers", () => {
  const volunteerConfig = {
    courses: [courseRow()],
    volunteers: [
      {
        id: 61,
        status: "pending",
        mark: 71,
        user_id: "v1",
        users: { name: "Vi V", email: "vi@wits.ac.za" },
      },
      {
        id: 62,
        status: "approved",
        user_id: "v2",
        users: { name: "Wes W", email: "wes@wits.ac.za" },
      },
      {
        id: 63,
        status: "open",
        session_date: "2026-02-03",
        start_time: "14:00:00",
        end_time: "16:00:00",
        venue: "MSL010",
      },
    ],
  };

  test("volunteer rows render per status; approve PATCHes with the note and lock confirms", async () => {
    const window = loadBoard(volunteerConfig, {
      url: "http://localhost/board.html?course=1",
    });
    await settle();

    const rows = window.document.querySelectorAll("#volunteerList .tutor-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector(".name").textContent).toBe("Vi V");
    expect(rows[0].textContent).toContain("Mark 71");
    expect(rows[1].querySelector(".name").textContent).toBe("Wes W");
    // The unclaimed overflow session shows its own label and slot stamp.
    expect(rows[2].querySelector(".name").textContent).toBe("Open — unclaimed");
    expect(rows[2].textContent).toContain("03/02/2026 · 14:00–16:00 · MSL010");

    rows[0].querySelector(".btn-small.approve").click();
    await settle();
    expect(window.document.getElementById("reasonHeading").textContent).toBe(
      "Approve Vi V for COMS1010A?",
    );
    window.document.getElementById("reasonInput").value = "Great mark";
    window.document.getElementById("reasonForm").requestSubmit();
    await settle();

    expect(
      requests.find((r) => r.url.endsWith("/api/course-volunteers/61")).body,
    ).toMatchObject({
      status: "approved",
      approvalReason: "Great mark",
      organiserId: "org-1",
    });
    expect(notify()).toBe("Vi V approved for COMS1010A");

    const lockBtn = Array.from(
      window.document
        .querySelectorAll("#volunteerList .tutor-row")[1]
        .querySelectorAll(".applicant-actions .btn-small"),
    ).find((b) => b.textContent === "Lock");
    lockBtn.click();
    await settle();
    expect(
      requests.find((r) => r.url.endsWith("/api/course-volunteers/62/lock"))
        .body,
    ).toEqual({ locked: true });
    expect(notify()).toBe("Wes W's approval for COMS1010A is now locked.");
  });

  test("posting an overflow session validates times then POSTs the gap", async () => {
    const window = loadBoard(volunteerConfig, {
      url: "http://localhost/board.html?course=1",
    });
    await settle();

    window.document.getElementById("postOverflowSessionBtn").click();
    await settle();
    const modal = window.document.getElementById("postOverflowSessionModal");
    expect(modal.open).toBe(true);
    expect(
      window.document.getElementById("postOverflowSessionModalContext")
        .textContent,
    ).toContain("Post a specific gap in COMS1010A");

    window.document.getElementById("overflowSessionDateInput").value =
      "2026-03-05";
    window.document.getElementById("overflowSessionStartInput").value = "14:00";
    window.document.getElementById("overflowSessionEndInput").value = "13:00";
    window.document.getElementById("postOverflowSessionForm").requestSubmit();
    await settle();
    expect(
      window.document.getElementById("postOverflowSessionFormError").hidden,
    ).toBe(false);
    expect(
      window.document.getElementById("postOverflowSessionFormError")
        .textContent,
    ).toBe("End time must be after start time.");

    window.document.getElementById("overflowSessionEndInput").value = "16:00";
    window.document.getElementById("overflowSessionVenueInput").value =
      " SHW1 ";
    window.document.getElementById("overflowSessionReasonInput").value =
      "Test crunch";
    window.document.getElementById("postOverflowSessionForm").requestSubmit();
    await settle();

    expect(modal.open).toBe(false);
    const post = requests.find(
      (r) => r.method === "POST" && r.url === "/api/course-volunteers",
    );
    expect(post.body).toEqual({
      courseId: 1,
      sessionDate: "2026-03-05",
      startTime: "14:00",
      endTime: "16:00",
      venue: "SHW1",
      reason: "Test crunch",
      organiserId: "org-1",
    });
    expect(notify()).toBe("Posted a COMS1010A session for volunteers to claim");
  });
});

// ---------- diagonals ----------

describe("board.js — diagonals", () => {
  test("diagonal groups render and members move; split asks and POSTs", async () => {
    const window = loadBoard(
      {
        courses: [courseRow({ diagonal_count: 2 })],
        diagonals: {
          diagonals: [
            {
              label: "A",
              tutors: [{ id: "t9", name: "Tim T", email: "tim@wits.ac.za" }],
              volunteers: [],
            },
            {
              label: "B",
              tutors: [],
              volunteers: [
                {
                  id: 62,
                  name: "Wes W",
                  email: "wes@wits.ac.za",
                  diagonal: "B",
                },
              ],
            },
          ],
          unassigned: {
            tutors: [],
            volunteers: [
              { id: 63, name: "Un V", email: "un@wits.ac.za", diagonal: null },
            ],
          },
        },
      },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    expect(window.document.getElementById("diagonalsPanel").hidden).toBe(false);
    const cards = window.document.querySelectorAll(
      "#diagonalGrid .diagonal-card",
    );
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector("h4").textContent).toBe("Diagonal A");
    expect(cards[0].querySelector(".diagonal-card-counts").textContent).toBe(
      "1 tutor · 0 volunteers",
    );
    expect(cards[2].querySelector("h4").textContent).toBe("Unassigned");

    // Move Wes from diagonal B to A via the member select.
    const wesSelect = cards[1].querySelector(".diagonal-member-select");
    expect(wesSelect.value).toBe("B");
    wesSelect.value = "A";
    wesSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await settle();
    expect(
      requests.find((r) => r.url.endsWith("/diagonals/members")).body,
    ).toEqual({ kind: "volunteer", id: 62, diagonal: "A" });
    expect(notify()).toBe("Wes W moved to diagonal A");

    window.document.getElementById("splitDiagonalsBtn").click();
    await settle();
    expect(
      requests.find((r) => r.url.endsWith("/diagonals/split")),
    ).toBeDefined();
    expect(notify()).toBe("COMS1010A split across 2 diagonals.");
  });
});

// ---------- obvious fill + auto-allocate (super-organiser tools) ----------

const SUPER = { id: "org-1", name: "Olive Organiser", role: "super_organiser" };

describe("board.js — obvious fill", () => {
  test("lists fillable groups and bulk-approves the checked rows", async () => {
    const window = loadBoard(
      {
        courses: [courseRow()],
        obviousFill: [
          {
            course: { code: "COMS1010A", name: "Intro to Algorithms" },
            applications: [
              { id: 31, tutorName: "Tim T", mark: 75 },
              { id: 32, tutorName: "Rex R", mark: 80 },
            ],
          },
        ],
      },
      { user: SUPER },
    );
    await settle();

    window.document.getElementById("obviousFillBtn").click();
    await settle();
    const modal = window.document.getElementById("obviousFillModal");
    expect(modal.open).toBe(true);
    expect(
      window.document.getElementById("obviousFillHint").textContent,
    ).toContain(
      "2 applications across 1 course can be filled without any judgment call",
    );
    expect(
      window.document.getElementById("obviousFillList").textContent,
    ).toContain("COMS1010A — Intro to Algorithms");

    const checks = window.document.querySelectorAll(".obvious-fill-check");
    expect(checks).toHaveLength(2);
    checks[1].click(); // leave Rex for a human decision
    await settle();

    window.document.getElementById("obviousFillConfirmBtn").click();
    await settle();

    const bulk = requests.find(
      (r) => r.url === "/api/tutor-applications/bulk-approve",
    );
    expect(bulk.method).toBe("POST");
    expect(bulk.body).toEqual({ applicationIds: ["31"] });
    expect(notify()).toBe(
      "1 filled, 1 couldn't be — something changed since you opened this.",
    );
    expect(modal.open).toBe(false);
  });
});

describe("board.js — auto-allocate", () => {
  test("proposes assignments with skipped candidates and publishes with exclusions", async () => {
    const window = loadBoard(
      {
        courses: [courseRow()],
        autoAllocate: {
          draft: { id: 77 },
          assignments: [
            {
              id: "as1",
              course_id: 1,
              course: {
                course_code: "COMS1010A",
                course_name: "Intro to Algorithms",
              },
              tutor: { name: "Tim T" },
              explanation: "Only eligible applicant",
            },
          ],
          skipped: [
            {
              courseId: 1,
              tutorName: "Rex R",
              reason: "Over their weekly hour cap",
            },
          ],
        },
      },
      { user: SUPER },
    );
    await settle();

    window.document.getElementById("autoAllocateBtn").click();
    await settle();
    const modal = window.document.getElementById("autoAllocateModal");
    expect(modal.open).toBe(true);
    expect(
      window.document.getElementById("autoAllocateHint").textContent,
    ).toContain("1 assignment proposed across every course with an open slot");
    const listText =
      window.document.getElementById("autoAllocateList").textContent;
    expect(listText).toContain("COMS1010A — Intro to Algorithms");
    expect(listText).toContain("Only eligible applicant");
    expect(listText).toContain("Not proposed");
    expect(listText).toContain("Rex R — COMS1010A");
    expect(listText).toContain("Over their weekly hour cap");

    window.document.getElementById("autoAllocatePublishBtn").click();
    await settle();

    const publish = requests.find((r) =>
      r.url.endsWith("/allocation-drafts/77/publish"),
    );
    expect(publish.body).toEqual({
      organiserId: "org-1",
      excludeAssignmentIds: [],
    });
    expect(notify()).toBe("1 assignment published.");
    expect(modal.open).toBe(false);
  });
});

// ---------- add / edit / delete course modals ----------

describe("board.js — course modals", () => {
  test("add course builds the full payload and reports the new code", async () => {
    const window = loadBoard({ courses: [courseRow()] }, { user: SUPER });
    await settle();

    expect(window.document.getElementById("addCourseBtn").hidden).toBe(false);
    window.document.getElementById("addCourseBtn").click();
    await settle();
    const modal = window.document.getElementById("addCourseModal");
    expect(modal.open).toBe(true);
    expect(window.document.getElementById("addCourseHeading").textContent).toBe(
      "Add a course",
    );

    const byId = (id) => window.document.getElementById(id);
    byId("hasTutorialInput").checked = true;
    byId("hasTutorialInput").dispatchEvent(
      new window.Event("change", { bubbles: true }),
    );
    expect(byId("tutorialFields").hidden).toBe(false);

    byId("courseCodeInput").value = "COMS3035A";
    byId("courseNameInput").value = "Compilers";
    byId("minMarkInput").value = "65";
    byId("courseLevelInput").value = "honours";
    byId("departmentInput").value = "Computer Science";
    byId("hoursPerWeekInput").value = "4";
    byId("TutorsNeededInput").value = "1";
    byId("budgetInput").value = "400";
    byId("dayOfTutInput").value = "Friday";
    byId("tutorStartTimeInput").value = "09:00";
    byId("tutorEndTimeInput").value = "11:00";
    byId("venuesInput").value = "SHW2";

    byId("addCourseForm").requestSubmit();
    await settle();

    expect(modal.open).toBe(false);
    const post = requests.find(
      (r) => r.method === "POST" && r.url === "/api/courses",
    );
    expect(post.body).toMatchObject({
      userId: "org-1",
      course_code: "COMS3035A",
      course_name: "Compilers",
      min_mark: 65,
      course_level: "honours",
      hours_per_week: 4,
      tutors_needed: 1,
      budget: 400,
      has_tutorial: true,
      day_of_tut: "Friday",
      tutor_start_time: "09:00",
      tutor_end_time: "11:00",
      venues: "SHW2",
      has_lab: false,
      has_diagonals: false,
      diagonal_count: null,
    });
    expect(notify()).toBe("COMS3035A added to the course register.");
  });

  test("edit course prefills and the live clash preview blocks then allows submit", async () => {
    const window = loadBoard(
      { courses: [courseRow(), course2Row()] },
      { url: "http://localhost/board.html?course=2" },
    );
    await settle();

    window.document.getElementById("editCourseBtn").click();
    await settle();
    const modal = window.document.getElementById("addCourseModal");
    expect(modal.open).toBe(true);
    expect(window.document.getElementById("addCourseHeading").textContent).toBe(
      "Edit course",
    );
    expect(window.document.getElementById("courseCodeInput").value).toBe(
      "COMS2020B",
    );
    expect(window.document.getElementById("hasLabInput").checked).toBe(true);

    const byId = (id) => window.document.getElementById(id);
    const input = (id) =>
      byId(id).dispatchEvent(new window.Event("input", { bubbles: true }));

    // Add a Thursday tutorial in another course's room and time — clash.
    byId("hasTutorialInput").checked = true;
    byId("hasTutorialInput").dispatchEvent(
      new window.Event("change", { bubbles: true }),
    );
    byId("dayOfTutInput").value = "Thursday";
    byId("tutorStartTimeInput").value = "10:00";
    byId("tutorEndTimeInput").value = "12:00";
    byId("venuesInput").value = "MSL004";
    input("venuesInput");
    await settle();

    expect(byId("courseClashWarning").hidden).toBe(false);
    expect(byId("courseClashWarning").textContent).toContain(
      "Tutorial clash: MSL004 is already booked for COMS1010A Tutorial",
    );
    expect(byId("addCourseSubmitBtn").disabled).toBe(true);

    // Move the tutorial to a free room — clash cleared.
    byId("venuesInput").value = "SHW3";
    input("venuesInput");
    await settle();
    expect(byId("courseClashWarning").hidden).toBe(true);

    // The course's own Lab overlaps the tutorial in the same room — self-clash.
    byId("dayOfLabInput").value = "Thursday";
    input("dayOfLabInput");
    byId("labStartTimeInput").value = "11:00";
    input("labStartTimeInput");
    byId("labEndTimeInput").value = "13:00";
    input("labEndTimeInput");
    byId("labVenuesInput").value = "SHW3";
    input("labVenuesInput");
    await settle();
    expect(byId("courseClashWarning").textContent).toContain(
      "own Tutorial and Lab overlap each other (SHW3, Thursday)",
    );
    expect(byId("addCourseSubmitBtn").disabled).toBe(true);

    // Lab back to its original Friday slot — submittable again.
    byId("dayOfLabInput").value = "Friday";
    input("dayOfLabInput");
    byId("labStartTimeInput").value = "14:00";
    input("labStartTimeInput");
    byId("labEndTimeInput").value = "16:00";
    input("labEndTimeInput");
    byId("labVenuesInput").value = "MSL010";
    input("labVenuesInput");
    await settle();
    expect(byId("courseClashWarning").hidden).toBe(true);
    expect(byId("addCourseSubmitBtn").disabled).toBe(false);

    byId("addCourseForm").requestSubmit();
    await settle();
    const put = requests.find(
      (r) => r.method === "PUT" && r.url === "/api/courses/2",
    );
    expect(put.body.course_code).toBe("COMS2020B");
    expect(notify()).toBe("COMS2020B updated.");
    expect(modal.open).toBe(false);
  });

  test("delete course confirms, DELETEs and drops it from the rail", async () => {
    const window = loadBoard(
      { courses: [courseRow(), course2Row()] },
      { url: "http://localhost/board.html?course=1" },
    );
    await settle();

    window.document.getElementById("deleteCourseBtn").click();
    await settle();
    const modal = window.document.getElementById("deleteCourseModal");
    expect(modal.open).toBe(true);
    expect(
      window.document.getElementById("deleteCourseMessage").textContent,
    ).toBe("Delete COMS1010A — Intro to Algorithms? This can't be undone.");

    window.document.getElementById("deleteCourseConfirmBtn").click();
    await settle();

    expect(
      requests.find((r) => r.method === "DELETE" && r.url === "/api/courses/1"),
    ).toBeDefined();
    expect(modal.open).toBe(false);
    expect(window.document.getElementById("railCount").textContent).toBe("1");
  });
});

// ---------- locked courses and access requests ----------

const SCOPED = {
  id: "org-1",
  name: "Sasha Scoped",
  role: "organiser",
  courseIds: [1],
};

describe("board.js — locked courses", () => {
  test("locked cards render, queued requests shape the button, and a new ask POSTs", async () => {
    const window = loadBoard(
      {
        courses: [courseRow(), course2Row()],
        accessRequests: [{ course_id: 2, status: "denied" }],
      },
      { user: SCOPED },
    );
    await settle();

    expect(
      requests.find((r) => r.url.startsWith("/api/organiser-requests/mine")),
    ).toBeDefined();
    const lockedCard = window.document.querySelector(
      '.course-card[data-course-id="2"]',
    );
    expect(lockedCard.classList.contains("course-card--locked")).toBe(true);
    expect(lockedCard.querySelector(".course-card__status").textContent).toBe(
      "No access",
    );
    expect(lockedCard.querySelector(".course-card__meta").textContent).toBe(
      "Select to request access",
    );

    lockedCard.click();
    await settle();
    expect(window.document.getElementById("lockedPanel").hidden).toBe(false);
    const btn = window.document.getElementById("requestAccessBtn");
    expect(btn.textContent).toBe("Request again"); // denied earlier

    btn.click();
    await settle();
    const post = requests.find(
      (r) => r.method === "POST" && r.url === "/api/organiser-requests",
    );
    expect(post.body).toEqual({ userId: "org-1", courseId: 2 });
    expect(notify()).toBe(
      "Access to COMS2020B requested — the super-organiser will review it.",
    );
    expect(window.document.getElementById("requestAccessBtn").textContent).toBe(
      "Request pending",
    );
    expect(window.document.getElementById("requestAccessBtn").disabled).toBe(
      true,
    );
  });

  test("a 409 conflict adopts the queue's real status", async () => {
    const window = loadBoard(
      {
        courses: [courseRow(), course2Row()],
        accessRequestConflict: true,
      },
      { user: SCOPED },
    );
    await settle();

    window.document.querySelector('.course-card[data-course-id="2"]').click();
    await settle();
    expect(window.document.getElementById("requestAccessBtn").textContent).toBe(
      "Request access",
    );

    window.document.getElementById("requestAccessBtn").click();
    await settle();
    expect(notify()).toBe("already requested");
    expect(window.document.getElementById("requestAccessBtn").textContent).toBe(
      "Request pending",
    );
  });
});

// ---------- deep link + live updates ----------

describe("board.js — init deep link and live updates", () => {
  test("?course= selects that course and a visibility ping refreshes the sync stamp", async () => {
    const window = loadBoard(
      { courses: [courseRow(), course2Row()] },
      { url: "http://localhost/board.html?course=2" },
    );
    await settle();

    expect(window.document.getElementById("dCode").textContent).toBe(
      "COMS2020B",
    );

    const sync = window.document.getElementById("syncStatus");
    expect(sync.classList.contains("is-flashing")).toBe(false);
    window.document.dispatchEvent(new window.Event("visibilitychange"));
    await settle();
    expect(sync.classList.contains("is-flashing")).toBe(true);
  });
});
