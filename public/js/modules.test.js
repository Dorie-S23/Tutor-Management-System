// modules.js is a real ES module (imports from ./nav.js, ./storage.js,
// ./highlightTarget.js and ./transcript-upload.js), so — same approach as the
// studentview.js test — we inline it as a classic script with those imports
// stubbed out, sharing scope with the test hooks below. window.fetch has to
// be stubbed inside beforeParse: the page's init IIFE runs during parsing,
// so anything set after `new JSDOM(...)` returns is too late for it.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "modules.html"),
  "utf8",
);

// The import lines are blanked out in place (same byte length) rather than
// removed, so the inline script shares every line and byte offset with the
// real file and the V8 coverage jest collects for it (matched back to the
// file via the sourceURL comment) lines up exactly instead of smearing
// across the file.
function blankImports(src, moduleNames) {
  const re = new RegExp(
    `^import[\\s\\S]*?from "\\.\\/(?:${moduleNames})\\.js";`,
    "gm",
  );
  return src.replace(re, (match) => match.replace(/[^\n]/g, " "));
}

const modulesSrc = blankImports(
  fs.readFileSync(path.join(__dirname, "modules.js"), "utf8"),
  "nav|storage|highlightTarget|transcript-upload",
);

// Stubs for the blanked imports. They sit *after* the page source in the
// inline script (see loadPage) so the source keeps the file's line numbering;
// function declarations hoist across the whole script, so the page's
// top-level requireRole() call still finds them. Their config
// (window.__user etc.) is injected in beforeParse, before any of it runs.
const stubs = `
function requireRole() {
  return window.__user;
}
function highlightActiveTab() {}
async function initTranscriptUpload(tutorId) {
  window.__transcriptInit.push(tutorId);
}
function consumeQueryParam(name) {
  return name in window.__params ? window.__params[name] : null;
}
function scrollAndHighlight(el) {
  window.__highlighted.push(el);
}
`;

function loadPage({
  user = { id: "tutor-1", name: "Thabo", role: "tutor" },
  courses = defaultCourses(),
  applications = defaultApplications(),
  academicLevel = "honours",
  coursesFail = false,
  applicationsFail = false,
  applicationDeleteFail = false,
  applicationPostFail = false,
  params = {},
} = {}) {
  const script = `<script>${modulesSrc}
${stubs}
//# sourceURL=${pathToFileURL(path.join(__dirname, "modules.js")).href}</script>`;
  const pageHtml = html
    .replace('<script type="module" src="../js/modules.js"></script>', script)
    .replace('<script src="../js/user-badge.js"></script>', "")
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (e) => jsdomErrors.push(e));

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/modules.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Test hooks and stub config, ready before the page script runs.
      window.__user = user;
      window.__params = params;
      window.__highlighted = [];
      window.__transcriptInit = [];
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
      // jsdom ships HTMLDialogElement but not its modal API — stub just
      // enough for the apply and confirm dialogs to open and close.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {
          this.open = true;
        };
        window.HTMLDialogElement.prototype.close = function () {
          this.open = false;
        };
      }

      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = opts.method || "GET";
        calls.push({
          url: u,
          method,
          body: opts.body ? JSON.parse(opts.body) : null,
        });
        if (u.includes("/api/courses")) {
          if (coursesFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          return { ok: true, json: async () => courses };
        }
        if (u.startsWith("/api/tutors/")) {
          return {
            ok: true,
            json: async () => ({ academic_level: academicLevel }),
          };
        }
        if (u.includes("/api/tutor-applications") && method === "DELETE") {
          if (applicationDeleteFail) {
            return {
              ok: false,
              json: async () => ({ error: "Locked by review" }),
            };
          }
          return { ok: true, status: 204, json: async () => ({}) };
        }
        if (u.includes("/api/tutor-applications") && method === "POST") {
          if (applicationPostFail) {
            return {
              ok: false,
              json: async () => ({ error: "Transcript required" }),
            };
          }
          return { ok: true, json: async () => ({ id: "a9" }) };
        }
        if (u.includes("/api/tutor-applications")) {
          if (applicationsFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          return { ok: true, json: async () => applications };
        }
        return { ok: true, json: async () => ({}) };
      };
    },
  });

  return { window: dom.window, calls, jsdomErrors };
}

// Six modules covering the fixture matrix: one fully-scheduled unapplied
// module, three with pending/approved/rejected applications, one with no
// level requirement, and one above the tutor's own level.
function defaultCourses() {
  return [
    {
      id: 1,
      course_code: "COMS1010",
      course_name: "Applied Data Science",
      course_level: 4,
      hours_per_week: 6,
      min_mark: 75,
      Day_of_tut: "Tuesday",
      tutor_start_time: "14:00:00",
      tutor_end_time: "15:00:00",
      venues: "FNB 1.40",
    },
    {
      id: 2,
      course_code: "MATH2000",
      course_name: "Algebra",
      course_level: 3,
      min_mark: 60,
    },
    {
      id: 3,
      course_code: "PHYS3000",
      course_name: "Waves",
      course_level: 4,
      hours_per_week: 5,
    },
    {
      id: 4,
      course_code: "CHEM4000",
      course_name: "Reactions",
      course_level: 5,
      min_mark: 70,
    },
    {
      id: 5,
      course_code: "GEOG0500",
      course_name: "Earth",
      min_mark: 60,
    },
    {
      id: 6,
      course_code: "ASTR9000",
      course_name: "Cosmology",
      course_level: 9,
    },
  ];
}

function defaultApplications() {
  return [
    {
      id: "a2",
      course_id: 2,
      status: "pending",
      courses: { course_code: "MATH2000", course_name: "Algebra" },
    },
    {
      id: "a3",
      course_id: 3,
      status: "approved",
      approval_reason: "Strong marks",
      courses: { course_code: "PHYS3000", course_name: "Waves" },
    },
    {
      id: "a4",
      course_id: 4,
      status: "rejected",
      rejection_reason: "Mark below minimum",
      courses: { course_code: "CHEM4000", course_name: "Reactions" },
    },
  ];
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const findCall = (calls, urlPart, method = "GET") =>
  calls.find((c) => c.method === method && c.url.includes(urlPart));

function cardFor(window, courseCode) {
  return [
    ...window.document.querySelectorAll("#module-grid .module-card"),
  ].find(
    (c) => c.querySelector(".module-card__code").textContent === courseCode,
  );
}

function openApplyModal(window, courseValue) {
  const doc = window.document;
  doc.getElementById("apply-to-tutor-btn").click();
  if (courseValue != null) {
    doc.getElementById("apply-course-select").value = courseValue;
    doc
      .getElementById("apply-course-select")
      .dispatchEvent(new window.Event("change", { bubbles: true }));
  }
}

function submitApplyForm(window) {
  window.document
    .getElementById("apply-form")
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
}

describe("modules.js", () => {
  test("bounces an unauthorised visitor before fetching anything", async () => {
    const { calls, jsdomErrors } = loadPage({ user: null });
    await wait();

    expect(calls).toHaveLength(0);
    const messages = jsdomErrors
      .map((e) => `${e.message} ${e.detail && e.detail.message}`)
      .join("\n");
    expect(messages).toContain("Not authorized");
  });

  test("renders every open module card with its requirements", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    const cards = doc.querySelectorAll("#module-grid .module-card");
    expect(cards).toHaveLength(6);

    const coms = cardFor(window, "COMS1010");
    expect(coms.querySelector(".module-card__name").textContent).toBe(
      "Applied Data Science",
    );
    const meta = [...coms.querySelectorAll(".module-card__meta span")].map(
      (s) => s.textContent,
    );
    expect(meta).toEqual([
      "Honours level or higher",
      "Up to 6h per week · Minimum 75%",
      "Tutorial · Tuesday · 14:00–15:00",
      "FNB 1.40",
    ]);

    const math = cardFor(window, "MATH2000");
    expect(math.textContent).toContain("Tutorial day/time not set yet");
    const geog = cardFor(window, "GEOG0500");
    expect(geog.textContent).toContain("Open to all years");

    // Accent colours cycle through the grid.
    expect(cards[0].className).toContain("module-card--blue");
    expect(cards[1].className).toContain("module-card--violet");
    expect(cards[2].className).toContain("module-card--amber");
    expect(cards[3].className).toContain("module-card--rose");
    expect(cards[4].className).toContain("module-card--blue");
  });

  test("badges each card against the tutor's academic level", async () => {
    const { window } = loadPage();
    await wait();

    expect(cardFor(window, "MATH2000").textContent).toContain("Strong match");
    expect(cardFor(window, "COMS1010").textContent).toContain("Eligible");
    expect(cardFor(window, "PHYS3000").textContent).toContain("Eligible");
    expect(cardFor(window, "CHEM4000").textContent).toContain("Needs Masters");
    expect(cardFor(window, "ASTR9000").textContent).toContain(
      "Needs a higher level",
    );
    expect(cardFor(window, "GEOG0500").querySelector(".badge")).toBeNull();
  });

  test("skips the badges when the tutor has no academic level on file", async () => {
    const { window } = loadPage({ academicLevel: null });
    await wait();

    expect(
      window.document.querySelectorAll("#module-grid .badge"),
    ).toHaveLength(0);
    // The apply modal's year dropdown isn't preselected either.
    openApplyModal(window);
    expect(window.document.getElementById("apply-year-select").value).toBe("");
  });

  test("shows the empty state when no modules are open", async () => {
    const { window } = loadPage({ courses: [] });
    await wait();

    expect(window.document.getElementById("module-grid").textContent).toContain(
      "No modules are open for applications right now",
    );
  });

  test("shows a danger toast when the module list fails to load", async () => {
    const { window } = loadPage({ coursesFail: true });
    await wait();

    const toast = window.document.getElementById("toast");
    expect(toast.textContent).toBe("Couldn't load modules from the database.");
    expect(toast.classList.contains("toast--danger")).toBe(true);
    expect(window.document.getElementById("module-grid").textContent).toContain(
      "No modules are open for applications right now",
    );
  });

  test("reflects the application state on each card", async () => {
    const { window } = loadPage();
    await wait();

    const applyBtn = cardFor(window, "COMS1010").querySelector("button");
    expect(applyBtn.textContent).toBe("Apply for module");
    expect(applyBtn.dataset.applyCourse).toBe("1");

    expect(
      cardFor(window, "MATH2000").querySelector(".btn-soft").textContent,
    ).toBe("Application submitted");
    expect(
      cardFor(window, "PHYS3000").querySelector(".btn-soft").textContent,
    ).toBe("You tutor this module");
    expect(
      cardFor(window, "CHEM4000").querySelector(".btn-soft").textContent,
    ).toBe("Application not approved");
  });

  test("counts submitted applications, singular and plural", async () => {
    const one = loadPage({
      applications: [defaultApplications()[0]],
    });
    await wait();
    const oneDoc = one.window.document;
    expect(oneDoc.getElementById("applications-count").hidden).toBe(false);
    expect(oneDoc.getElementById("applications-count").textContent).toBe(
      "1 application submitted",
    );

    const two = loadPage({ applications: defaultApplications() });
    await wait();
    const twoDoc = two.window.document;
    expect(twoDoc.getElementById("applications-count").textContent).toBe(
      "3 applications submitted",
    );
  });

  test("lists applications with the action each status needs", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    expect(doc.getElementById("applications-panel").hidden).toBe(false);
    const rows = doc.querySelectorAll("#applications-items .application-row");
    expect(rows).toHaveLength(3);

    const pending = rows[0];
    expect(pending.querySelector(".status-pill").textContent).toBe("pending");
    expect(pending.querySelector("button.btn-secondary").textContent).toBe(
      "Cancel",
    );

    const approved = rows[1];
    expect(approved.querySelector(".status-pill").textContent).toBe("approved");
    expect(approved.textContent).toContain("Note: Strong marks");
    expect(approved.querySelector("button")).toBeNull();

    const rejected = rows[2];
    expect(rejected.textContent).toContain("Reason: Mark below minimum");
    expect(rejected.querySelector("button.btn-link").textContent).toBe(
      "Remove & apply again",
    );
  });

  test("labels an application whose course record vanished", async () => {
    const { window } = loadPage({
      applications: [{ id: "a9", course_id: 99, status: "pending" }],
    });
    await wait();

    expect(
      window.document.querySelector("#applications-items .application-row")
        .textContent,
    ).toContain("Module application");
  });

  test("cancels a pending application only after confirming", async () => {
    const { window, calls } = loadPage();
    await wait();

    const doc = window.document;
    const cancelBtn = doc.querySelector(
      "#applications-items .application-row button.btn-secondary",
    );
    cancelBtn.click();
    await wait();

    const confirmModal = doc.getElementById("confirm-modal");
    expect(confirmModal.open).toBe(true);
    expect(doc.getElementById("confirm-modal-message").textContent).toContain(
      "Cancel your application for MATH2000 — Algebra?",
    );

    // Backing out cancels nothing.
    doc.getElementById("confirm-modal-cancel-btn").click();
    await wait();
    expect(confirmModal.open).toBe(false);
    expect(
      findCall(calls, "/api/tutor-applications", "DELETE"),
    ).toBeUndefined();

    // Confirming this time goes through.
    cancelBtn.click();
    await wait();
    doc.getElementById("confirm-modal-confirm-btn").click();
    await wait();

    const deleted = findCall(calls, "/api/tutor-applications/a2", "DELETE");
    expect(deleted).toBeTruthy();
    expect(doc.getElementById("toast").textContent).toBe(
      "Application cancelled.",
    );
    expect(
      doc.getElementById("toast").classList.contains("toast--danger"),
    ).toBe(true);
    expect(
      calls.filter((c) => c.url.includes("/api/tutor-applications?")).length,
    ).toBe(2);
  });

  test("removes a rejected application to apply again", async () => {
    const { window, calls } = loadPage();
    await wait();

    const doc = window.document;
    const removeBtn = doc.querySelector(
      "#applications-items .application-row button.btn-link",
    );
    removeBtn.click();
    await wait();
    expect(doc.getElementById("confirm-modal-message").textContent).toContain(
      "Remove this application for CHEM4000 — Reactions?",
    );
    doc.getElementById("confirm-modal-confirm-btn").click();
    await wait();

    expect(
      findCall(calls, "/api/tutor-applications/a4", "DELETE"),
    ).toBeTruthy();
    expect(doc.getElementById("toast").textContent).toBe(
      "Application removed.",
    );
  });

  test("a locked rejection shows a note instead of the remove button", async () => {
    const { window, calls } = loadPage({
      applications: defaultApplications().map((a) =>
        a.id === "a4" ? { ...a, locked: true } : a,
      ),
    });
    await wait();

    const doc = window.document;
    const rows = doc.querySelectorAll("#applications-items .application-row");
    const rejected = rows[2];
    expect(rejected.querySelector("button.btn-link")).toBeNull();
    expect(rejected.textContent).toContain(
      "An organiser has locked this rejection",
    );
    expect(calls.find((c) => c.method === "DELETE")).toBeUndefined();
  });

  test("keeps the application and re-enables the button when removal fails", async () => {
    const { window, calls } = loadPage({ applicationDeleteFail: true });
    await wait();

    const doc = window.document;
    const removeBtn = doc.querySelector(
      "#applications-items .application-row button.btn-link",
    );
    removeBtn.click();
    await wait();
    doc.getElementById("confirm-modal-confirm-btn").click();
    await wait();

    expect(doc.getElementById("toast").textContent).toBe("Locked by review");
    expect(removeBtn.disabled).toBe(false);
    expect(
      calls.filter((c) => c.url.includes("/api/tutor-applications?")).length,
    ).toBe(1);
  });

  test("opens the apply modal with applied modules disabled", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    doc.getElementById("apply-to-tutor-btn").click();

    const modal = doc.getElementById("apply-modal");
    expect(modal.open).toBe(true);
    expect(doc.getElementById("apply-course-meta").hidden).toBe(true);

    const options = [...doc.getElementById("apply-course-select").options];
    expect(options[0].textContent).toBe("Choose a module…");
    const coms = options.find((o) => o.value === "1");
    expect(coms.textContent).toBe("COMS1010 — Applied Data Science");
    expect(coms.disabled).toBe(false);
    const math = options.find((o) => o.value === "2");
    expect(math.disabled).toBe(true);
    expect(math.textContent).toContain("(already applied)");
  });

  test("fills the course meta and availability label for the chosen module", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    openApplyModal(window, "1");

    const meta = doc.getElementById("apply-course-meta");
    expect(meta.hidden).toBe(false);
    expect(meta.textContent).toBe(
      "Requires a mark of 75+ · Honours level or higher · tutorial is Tuesday · 14:00–15:00",
    );
    expect(doc.getElementById("apply-availability-label").textContent).toBe(
      "Are you free on Tuesday · 14:00–15:00?",
    );
  });

  test("falls back to the not-set-yet copy when the tutorial time is missing", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    openApplyModal(window, "2");

    const meta = doc.getElementById("apply-course-meta");
    expect(meta.hidden).toBe(false);
    expect(meta.textContent).toBe(
      "Requires a mark of 60+ · 3rd year level or higher · tutorial day/time not yet set",
    );
    expect(doc.getElementById("apply-availability-label").textContent).toBe(
      "Are you free at the tutorial time?",
    );
  });

  test("preselects a module when applying from a card", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    cardFor(window, "COMS1010").querySelector("button").click();

    expect(doc.getElementById("apply-modal").open).toBe(true);
    expect(doc.getElementById("apply-course-select").value).toBe("1");
    expect(doc.getElementById("apply-course-meta").hidden).toBe(false);
  });

  test("submits the application and refreshes the list", async () => {
    const { window, calls } = loadPage();
    await wait();

    const doc = window.document;
    openApplyModal(window, "1");
    doc.getElementById("apply-mark-input").value = "78";
    doc.getElementById("apply-availability-select").value = "true";
    submitApplyForm(window);
    await wait();

    const posted = findCall(calls, "/api/tutor-applications", "POST");
    expect(posted.body).toEqual({
      tutorId: "tutor-1",
      courseId: 1,
      academicLevel: "honours",
      mark: 78,
      availability: true,
    });
    expect(doc.getElementById("apply-modal").open).toBe(false);
    expect(doc.getElementById("toast").textContent).toBe(
      "Application submitted!",
    );
    expect(
      calls.filter((c) => c.url.includes("/api/tutor-applications?")).length,
    ).toBe(2);
  });

  test("surfaces the server error when the application fails", async () => {
    const { window, calls } = loadPage({ applicationPostFail: true });
    await wait();

    const doc = window.document;
    openApplyModal(window, "1");
    doc.getElementById("apply-mark-input").value = "78";
    doc.getElementById("apply-availability-select").value = "true";
    submitApplyForm(window);
    await wait();

    const error = doc.getElementById("apply-form-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Transcript required");
    expect(doc.getElementById("apply-modal").open).toBe(true);

    const submitBtn = doc.getElementById("apply-submit-btn");
    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe("Submit application");
    expect(
      calls.filter((c) => c.url.includes("/api/tutor-applications?")).length,
    ).toBe(1);
  });

  test("closes the apply modal from the cancel button", async () => {
    const { window } = loadPage();
    await wait();

    const doc = window.document;
    doc.getElementById("apply-to-tutor-btn").click();
    expect(doc.getElementById("apply-modal").open).toBe(true);
    doc.getElementById("apply-cancel-btn").click();
    expect(doc.getElementById("apply-modal").open).toBe(false);
  });

  test("scrolls to the highlighted application on arrival", async () => {
    const { window } = loadPage({ params: { highlightApplication: "a2" } });
    await wait();

    expect(window.__highlighted).toHaveLength(1);
    expect(window.__highlighted[0].getAttribute("data-application-id")).toBe(
      "a2",
    );
  });

  test("checks the transcript panel for the signed-in tutor", async () => {
    const { window } = loadPage();
    await wait();

    expect(window.__transcriptInit).toEqual(["tutor-1"]);
  });
});
