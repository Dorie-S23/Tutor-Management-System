// timesheets.js treats the Profile page as the source of truth for the
// claim form's identity fields (name, student number, email, cell phone):
// non-empty Profile values overwrite the locally saved copies, lock the
// corresponding fields, and feed the rendered claim. Year of study locks
// the same way from the tutor's academic_level (served as yearOfStudy);
// payroll number stays editable and locally sourced, and a missing/failing profile fetch leaves the old
// local-only behaviour untouched. Loads the real storage.js + timesheets.js
// sources into jsdom, the same way volunteer-timesheets.render.test.js does,
// stubbing only the network, nav and dialog bits.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const rawStorageJs = fs.readFileSync(
  path.join(__dirname, "storage.js"),
  "utf8",
);
const storageJsUrl = pathToFileURL(path.join(__dirname, "storage.js")).href;
const rawTimesheetsJs = fs
  .readFileSync(path.join(__dirname, "timesheets.js"), "utf8")
  // Import blocks (including the multiline one from storage.js) aren't
  // valid inside dom.window.eval — classic script semantics, so they're
  // stripped and the bindings come from eval'ing the real sources below.
  .replace(/import\s*{[^}]*}\s*from\s*["'][^"']+["'];?/g, "");
const timesheetsJsUrl = pathToFileURL(
  path.join(__dirname, "timesheets.js"),
).href;
const dateMaskJs = fs.readFileSync(
  path.join(__dirname, "date-mask.js"),
  "utf8",
);
const dateMaskJsUrl = pathToFileURL(path.join(__dirname, "date-mask.js")).href;

// The identical newline-free shadow line storage.test.js prepends to its
// eval'd copy of storage.js — Jest's v8 coverage only merges the two
// suites' copies cleanly when their text layouts match.
const shadowWindow = `var __fakeLocation = { href: "" }; const window = { location: __fakeLocation }; `;

// What a previous visit saved on this device — deliberately different from
// the server profile, so tests can tell which source won.
const LOCAL_PROFILE = {
  fullName: "Local Tutor",
  studentNumber: "9999999",
  email: "local@example.co.za",
  cellPhone: "011 000 0000",
  yearOfStudy: "honours",
  payrollNumber: "P-100",
  // Legacy keys from when the form collected them — saving the form now
  // must drop these, not carry them forward.
  hourlyRate: 150,
  headOfSchool: "Prof Local",
};

const SERVER_PROFILE = {
  id: "tutor-1",
  name: "Adah Pardee",
  email: "adah@students.wits.ac.za",
  studentNumber: "1234567",
  cellPhone: "082 123 4567",
  yearOfStudy: "masters",
  role: "tutor",
};

const PAGE_HTML = `<!doctype html><html><body>
  <form id="profile-form">
    <input type="text" id="fullName" />
    <input type="text" id="studentNumber" />
    <input type="email" id="email" />
    <input type="tel" id="cellPhone" />
    <select id="yearOfStudy">
      <option value="third_year">3rd Year</option>
      <option value="honours">Honours</option>
      <option value="masters">Masters</option>
      <option value="phd">PhD</option>
    </select>
    <p class="hint" id="year-of-study-hint" hidden></p>
    <input type="text" id="payrollNumber" />
  </form>
  <p class="hint" id="details-sync-hint" hidden>
    Your name, student number, email and phone number come from your
    <a href="profile.html">Profile page</a> — change them there.
  </p>
  <input type="date" id="rangeFrom" />
  <input type="date" id="rangeTo" />
  <button type="button" id="printBtn"></button>
  <input type="month" id="submitMonth" />
  <button type="button" id="submitTimesheetBtn"></button>
  <p id="submitMonthHint"></p>
  <p id="timesheet-hint" hidden></p>
  <div id="claimWrapper" hidden>
    <div class="claim-form" id="claimForm">
      <span id="cYear"></span><span id="cFullName"></span>
      <span id="cStudentNo"></span><span id="cPayrollNo"></span>
      <span id="cEmail"></span><span id="cYearOfStudy"></span>
      <span id="cCellPhone"></span>
      <div id="claimRows"></div>
      <span id="cSignDate"></span><span id="cTotalHours"></span>
    </div>
  </div>
  <div id="submissionsList"></div>
  <p id="submissionsEmpty" hidden></p>
  <dialog id="disputeModal">
    <form id="disputeForm">
      <p id="disputeFormError" hidden></p>
      <p id="disputeModalContext"></p>
      <textarea id="disputeMessageInput"></textarea>
      <button type="button" id="disputeModalCloseBtn"></button>
      <button type="button" id="disputeCancelBtn"></button>
      <button type="submit" id="disputeSubmitBtn"></button>
    </form>
  </dialog>
  <button type="button" id="new-timesheet-btn"></button>
  <output id="toast"></output>
</body></html>`;

function renderPage({
  serverProfile = SERVER_PROFILE,
  profileDown = false,
  entries = [],
  withMask = false,
} = {}) {
  const dom = new JSDOM(PAGE_HTML, {
    url: "http://localhost/timesheets.html",
    runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "tutor-1", role: "tutor", name: "Local Tutor" }),
      );
      window.localStorage.setItem(
        "tutorHours.profile.tutor-1",
        JSON.stringify(LOCAL_PROFILE),
      );
      window.__fetchCalls = [];
      window.fetch = (url, init) => {
        const path = String(url);
        window.__fetchCalls.push({
          url: path,
          method: (init && init.method) || "GET",
        });
        if (path.startsWith("/api/profile/")) {
          if (profileDown) return Promise.reject(new Error("network down"));
          if (!serverProfile) {
            return Promise.resolve({
              ok: false,
              status: 404,
              json: async () => ({ error: "User not found" }),
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => serverProfile,
          });
        }
        if (path.startsWith("/api/hour-entries")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () =>
              entries.map((e) => ({
                start_time: "",
                end_time: "",
                task_type: "Tutoring",
                subject: "",
                notes: "",
                ...e,
              })),
          });
        }
        if (path.startsWith("/api/timesheets")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (path.startsWith("/api/timesheet-disputes")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      };
      // The CDN PDF libraries can't load in jsdom — the submit flow needs
      // stand-ins or it would wait forever on scripts that never load.
      window.html2canvas = () => Promise.resolve({ width: 800, height: 1200 });
      window.jspdf = {
        jsPDF: class {
          addImage() {}
          output() {
            return Promise.resolve(
              new window.Blob(["%PDF- fake"], { type: "application/pdf" }),
            );
          }
        },
      };
      // The dispute dialog never opens in these tests, but jsdom's dialog
      // support is patchy — stub the methods timesheets.js binds regardless.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {};
        window.HTMLDialogElement.prototype.close = function () {};
      }
      // highlightActiveTab is the one thing not worth loading nav.js for;
      // consumeQueryParam/scrollAndHighlight come from highlightTarget.js,
      // which no test here needs either.
      window.highlightActiveTab = function () {};
      window.consumeQueryParam = () => null;
      window.scrollAndHighlight = function () {};
    },
  });

  const storageJs = rawStorageJs.replace(
    /^export (async function|function)/gm,
    "$1",
  );
  if (withMask) {
    // Loaded first, exactly where timesheets.html loads it.
    dom.window.eval(`${dateMaskJs}\n//# sourceURL=${dateMaskJsUrl}`);
  }
  // One sourceURL per eval so each file's coverage lands on its own lines
  // (both evaluate in the window's global scope, so they still share
  // bindings across the two calls).
  dom.window.eval(`${shadowWindow}${storageJs}\n//# sourceURL=${storageJsUrl}`);
  dom.window.eval(`${rawTimesheetsJs}\n//# sourceURL=${timesheetsJsUrl}`);

  return dom.window;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("timesheets profile sync", () => {
  test("a filled Profile page overwrites, locks and renders its identity fields", async () => {
    const window = renderPage();
    await flush();

    const doc = window.document;
    expect(doc.getElementById("fullName").value).toBe("Adah Pardee");
    expect(doc.getElementById("studentNumber").value).toBe("1234567");
    expect(doc.getElementById("email").value).toBe("adah@students.wits.ac.za");
    expect(doc.getElementById("cellPhone").value).toBe("082 123 4567");

    for (const id of ["fullName", "studentNumber", "email", "cellPhone"]) {
      expect(doc.getElementById(id).readOnly).toBe(true);
      expect(doc.getElementById(id).title).toContain("Profile page");
    }
    expect(doc.getElementById("details-sync-hint").hidden).toBe(false);
    expect(doc.querySelector("#details-sync-hint a").getAttribute("href")).toBe(
      "profile.html",
    );

    // Year of study comes from the tutor record (overriding the local
    // "honours") and is locked, with its own hint.
    expect(doc.getElementById("yearOfStudy").value).toBe("masters");
    expect(doc.getElementById("yearOfStudy").disabled).toBe(true);
    expect(doc.getElementById("yearOfStudy").title).toContain("organiser");
    expect(doc.getElementById("year-of-study-hint").hidden).toBe(false);

    // Payroll number isn't held anywhere else: editable, locally sourced.
    expect(doc.getElementById("payrollNumber").value).toBe("P-100");
    expect(doc.getElementById("payrollNumber").readOnly).toBe(false);

    // The claim renders the Profile page's values, not the local copies.
    expect(doc.getElementById("claimWrapper").hidden).toBe(false);
    expect(doc.getElementById("cFullName").textContent).toBe("Adah Pardee");
    expect(doc.getElementById("cStudentNo").textContent).toBe("1234567");
    expect(doc.getElementById("cEmail").textContent).toBe(
      "adah@students.wits.ac.za",
    );
    expect(doc.getElementById("cCellPhone").textContent).toBe("082 123 4567");
    expect(doc.getElementById("cPayrollNo").textContent).toBe("P-100");
    expect(doc.getElementById("cYearOfStudy").textContent).toBe("Masters");
  });

  test("year of study stays editable when no recognised level is on record", async () => {
    for (const yearOfStudy of [undefined, "", "first_year"]) {
      const window = renderPage({
        serverProfile: { ...SERVER_PROFILE, yearOfStudy },
      });
      await flush();

      const doc = window.document;
      expect(doc.getElementById("yearOfStudy").disabled).toBe(false);
      expect(doc.getElementById("yearOfStudy").getAttribute("title")).toBe(
        null,
      );
      expect(doc.getElementById("yearOfStudy").value).toBe("honours");
      expect(doc.getElementById("year-of-study-hint").hidden).toBe(true);
      expect(doc.getElementById("cYearOfStudy").textContent).toBe("Honours");
    }
  });

  test("fields the Profile page leaves empty stay editable and fall back to local values", async () => {
    const window = renderPage({
      serverProfile: {
        id: "tutor-1",
        name: "",
        email: "adah@students.wits.ac.za",
        studentNumber: "1234567",
        cellPhone: "",
        role: "tutor",
      },
    });
    await flush();

    const doc = window.document;
    expect(doc.getElementById("fullName").value).toBe("Local Tutor");
    expect(doc.getElementById("fullName").readOnly).toBe(false);
    expect(doc.getElementById("fullName").getAttribute("title")).toBe(null);
    expect(doc.getElementById("cellPhone").value).toBe("011 000 0000");
    expect(doc.getElementById("cellPhone").readOnly).toBe(false);

    expect(doc.getElementById("studentNumber").readOnly).toBe(true);
    expect(doc.getElementById("email").readOnly).toBe(true);
    expect(doc.getElementById("details-sync-hint").hidden).toBe(false);

    // The claim mixes both sources: server number, locally entered name.
    expect(doc.getElementById("cFullName").textContent).toBe("Local Tutor");
    expect(doc.getElementById("cStudentNo").textContent).toBe("1234567");
  });

  test("with no Profile page record the form keeps its old local-only behaviour", async () => {
    const window = renderPage({ serverProfile: null });
    await flush();

    const doc = window.document;
    for (const id of ["fullName", "studentNumber", "email", "cellPhone"]) {
      expect(doc.getElementById(id).readOnly).toBe(false);
    }
    expect(doc.getElementById("details-sync-hint").hidden).toBe(true);
    expect(doc.getElementById("yearOfStudy").disabled).toBe(false);
    expect(doc.getElementById("year-of-study-hint").hidden).toBe(true);

    expect(doc.getElementById("fullName").value).toBe("Local Tutor");
    expect(doc.getElementById("cFullName").textContent).toBe("Local Tutor");
    expect(doc.getElementById("cEmail").textContent).toBe(
      "local@example.co.za",
    );
  });

  test("a failing profile fetch still leaves the locally saved details usable", async () => {
    const window = renderPage({ profileDown: true });
    await flush();

    const doc = window.document;
    expect(doc.getElementById("fullName").readOnly).toBe(false);
    expect(doc.getElementById("fullName").value).toBe("Local Tutor");
    expect(doc.getElementById("details-sync-hint").hidden).toBe(true);
    expect(doc.getElementById("claimWrapper").hidden).toBe(false);
    expect(doc.getElementById("cFullName").textContent).toBe("Local Tutor");
  });

  test("saving details stores the locked values in the locally kept profile too", async () => {
    const window = renderPage();
    await flush();

    const doc = window.document;
    doc.getElementById("payrollNumber").value = "P-200";
    doc
      .getElementById("profile-form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await flush();

    const saved = JSON.parse(
      window.localStorage.getItem("tutorHours.profile.tutor-1"),
    );
    // Locked fields persist the Profile page's values into the local copy…
    expect(saved.fullName).toBe("Adah Pardee");
    expect(saved.studentNumber).toBe("1234567");
    expect(saved.email).toBe("adah@students.wits.ac.za");
    expect(saved.cellPhone).toBe("082 123 4567");
    // The disabled year-of-study select still saves the locked level…
    expect(saved.yearOfStudy).toBe("masters");
    // …and the editable field updates as before.
    expect(saved.payrollNumber).toBe("P-200");
    // The removed fields don't survive a save.
    expect(saved.hourlyRate).toBeUndefined();
    expect(saved.headOfSchool).toBeUndefined();
  });

  // A typed "13/2026" leaves the native month input empty, so before this
  // check Submit couldn't tell it apart from "nothing picked"; now the
  // impossible month blocks the submit with the field's own message.
  test("an impossible typed month blocks the timesheet submit", async () => {
    const window = renderPage({ withMask: true });
    await flush();

    const doc = window.document;
    const monthField = doc.getElementById("submitMonth-typed");
    monthField.value = "13/2026";
    monthField.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(monthField.getAttribute("aria-invalid")).toBe("true");

    const posts = () =>
      window.__fetchCalls.filter(
        (call) => call.method === "POST" && call.url === "/api/timesheets",
      );

    doc.getElementById("submitTimesheetBtn").click();
    await flush();
    expect(posts()).toHaveLength(0);
    expect(doc.activeElement).toBe(monthField);
    expect(monthField.validationMessage).toMatch(/month doesn't exist/);

    // Fixing the month lets the submit through.
    monthField.value = "09/2026";
    monthField.dispatchEvent(new window.Event("input", { bubbles: true }));
    doc.getElementById("submitTimesheetBtn").click();
    await flush();
    expect(posts()).toHaveLength(1);
  });
});
