// The tutor's timesheets page, after an organiser rejects a month: the
// rejected row carries the reviewer's note plus a Resubmit button that
// re-points the submit tool at the month (hint and button label switch to
// the resubmit wording); submitting then POSTs the month's first day and
// toasts the resubmission. Submit also renders the claim PDF and uploads it
// first (stubbed html2canvas/jsPDF here, upload answered 201) — that part is
// exercised by timesheets.pdf.test.js; this suite stays on the resubmit
// flow. Pending and approved months stay locked — they
// show their own hints and never offer Resubmit — and a 409 from the server
// surfaces as the toast. Loads the real storage.js + timesheets.js sources
// into jsdom (the same harness style as timesheets.profile-sync.test.js),
// stubbing only the network, nav, dialog and scroll bits.
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
  // Import blocks aren't valid inside dom.window.eval — classic script
  // semantics — so they're stripped and the bindings come from eval'ing
  // the real sources below.
  .replace(/import\s*{[^}]*}\s*from\s*["'][^"']+["'];?/g, "");
const timesheetsJsUrl = pathToFileURL(
  path.join(__dirname, "timesheets.js"),
).href;

// The identical newline-free shadow line storage.test.js prepends to its
// eval'd copy of storage.js — Jest's v8 coverage only merges the suites'
// copies cleanly when their text layouts match.
const shadowWindow = `var __fakeLocation = { href: "" }; const window = { location: __fakeLocation }; `;

const REJECTED_ROW = {
  user_id: "tutor-1",
  week_start: "2026-09-01",
  status: "rejected",
  total_hours: 9,
  entries_snapshot: [{ date: "2026-09-03", hours: 9 }],
  reviewer_note: "Tuesday's hours look off",
  reviewed_at: "2026-09-10T10:00:00.000Z",
  submitted_at: "2026-09-02T08:00:00.000Z",
};

// A submitting tutor has claim identity on file — the submit flow gates on
// it and the PDF capture renders from it.
const PROFILE = {
  id: "tutor-1",
  name: "Thandi Tutor",
  email: "thandi@wits.ac.za",
  studentNumber: "1234567",
  cellPhone: "082 123 4567",
  yearOfStudy: "honours",
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
  <button type="button" id="submitTimesheetBtn">Submit for approval</button>
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

function renderPage({ submissions = [], entries = [], postTimesheet } = {}) {
  const dom = new JSDOM(PAGE_HTML, {
    url: "http://localhost/timesheets.html",
    runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "tutor-1", role: "tutor", name: "Local Tutor" }),
      );
      window.__fetchCalls = [];
      window.fetch = (url, init) => {
        const requestUrl = String(url);
        const method = (init && init.method) || "GET";
        window.__fetchCalls.push({ url: requestUrl, method, body: init?.body });

        if (requestUrl.startsWith("/api/profile/")) {
          // The submitting tutor's identity — the claim form (and the PDF
          // capture) renders from it.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => PROFILE,
          });
        }
        if (requestUrl.startsWith("/api/hour-entries")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => entries,
          });
        }
        // The claim PDF upload shares the /api/timesheets prefix but is its
        // own call — answer it before the submission branch below.
        if (requestUrl.includes("/pdf")) {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({ uploaded: true }),
          });
        }
        if (requestUrl.startsWith("/api/timesheet-disputes")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (requestUrl.startsWith("/api/timesheets")) {
          if (method === "POST") {
            const result = postTimesheet
              ? postTimesheet(JSON.parse(init.body))
              : { status: 201, body: {} };
            return Promise.resolve({
              ok: result.status >= 200 && result.status < 300,
              status: result.status,
              json: async () => result.body,
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => submissions,
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
      // jsdom's dialog + scroll support is patchy — stub the bits
      // timesheets.js binds or calls regardless.
      if (window.HTMLDialogElement) {
        window.HTMLDialogElement.prototype.showModal = function () {};
        window.HTMLDialogElement.prototype.close = function () {};
      }
      window.HTMLElement.prototype.scrollIntoView = function () {};
      window.highlightActiveTab = function () {};
      window.consumeQueryParam = () => null;
      window.scrollAndHighlight = function () {};
    },
  });

  const storageJs = rawStorageJs.replace(
    /^export (async function|function)/gm,
    "$1",
  );
  // One sourceURL per eval so each file's coverage lands on its own lines
  // (both evaluate in the window's global scope, so they still share
  // bindings across the two calls).
  dom.window.eval(`${shadowWindow}${storageJs}\n//# sourceURL=${storageJsUrl}`);
  dom.window.eval(`${rawTimesheetsJs}\n//# sourceURL=${timesheetsJsUrl}`);

  return dom.window;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("timesheets resubmit", () => {
  test("a rejected row shows the note and Resubmit; clicking re-points the submit tool", async () => {
    const window = renderPage({
      submissions: [REJECTED_ROW],
      entries: [
        { date: "2026-09-05", hours: 2 },
        { date: "2026-09-18", hours: 4 },
      ],
    });
    await flush();

    const doc = window.document;
    const row = doc.querySelector('[data-week-start="2026-09-01"]');
    expect(row.querySelector(".status-pill").textContent).toBe("Rejected");
    expect(row.querySelector(".ts-row__dispute").textContent).toBe(
      "Tuesday's hours look off",
    );

    const resubmitBtn = row.querySelector('[data-action="resubmit"]');
    expect(resubmitBtn.textContent).toBe("Resubmit");

    resubmitBtn.click();
    await flush();

    // The submit tool now points at the rejected month, with the resubmit
    // wording on both the hint and the button.
    expect(doc.getElementById("submitMonth").value).toBe("2026-09");
    const hint = doc.getElementById("submitMonthHint").textContent;
    expect(hint).toContain("6 hrs logged for September 2026");
    expect(hint).toContain("rejected");
    expect(hint).toContain("submit again to resubmit");
    expect(doc.getElementById("submitTimesheetBtn").textContent).toBe(
      "Resubmit for approval",
    );
  });

  test("submitting a rejected month POSTs its first day and toasts the resubmission", async () => {
    const posts = [];
    const window = renderPage({
      submissions: [REJECTED_ROW],
      entries: [{ date: "2026-09-05", hours: 2 }],
      postTimesheet: (body) => {
        posts.push(body);
        return {
          status: 200,
          body: { ...REJECTED_ROW, status: "pending", reviewer_note: null },
        };
      },
    });
    await flush();

    const doc = window.document;
    doc.querySelector('[data-action="resubmit"]').click();
    await flush();
    doc.getElementById("submitTimesheetBtn").click();
    await flush();

    expect(posts).toEqual([{ tutorId: "tutor-1", weekStart: "2026-09-01" }]);
    const toast = doc.getElementById("toast");
    expect(toast.textContent).toBe("Timesheet resubmitted for approval.");
    expect(toast.classList.contains("toast--success")).toBe(true);
  });

  test("pending and approved months show their hints and offer no Resubmit", async () => {
    const window = renderPage({
      submissions: [
        {
          user_id: "tutor-1",
          week_start: "2026-09-01",
          status: "pending",
          total_hours: 6,
          submitted_at: "2026-09-02T08:00:00.000Z",
        },
        {
          user_id: "tutor-1",
          week_start: "2026-08-01",
          status: "approved",
          total_hours: 6,
          submitted_at: "2026-08-02T08:00:00.000Z",
        },
      ],
      entries: [
        { date: "2026-09-05", hours: 6 },
        { date: "2026-08-05", hours: 6 },
      ],
    });
    await flush();

    const doc = window.document;
    expect(doc.querySelectorAll('[data-action="resubmit"]')).toHaveLength(0);

    const monthField = doc.getElementById("submitMonth");
    const pick = async (value) => {
      monthField.value = value;
      monthField.dispatchEvent(new window.Event("change", { bubbles: true }));
      await flush();
    };

    await pick("2026-09");
    expect(doc.getElementById("submitMonthHint").textContent).toContain(
      "already awaiting review",
    );
    expect(doc.getElementById("submitTimesheetBtn").textContent).toBe(
      "Submit for approval",
    );

    await pick("2026-08");
    expect(doc.getElementById("submitMonthHint").textContent).toContain(
      "already approved",
    );
    expect(doc.getElementById("submitTimesheetBtn").textContent).toBe(
      "Submit for approval",
    );
  });

  test("a 409 from the server surfaces its message as the toast", async () => {
    const window = renderPage({
      submissions: [],
      entries: [{ date: "2026-10-03", hours: 1 }],
      postTimesheet: () => ({
        status: 409,
        body: { error: "That month's timesheet is still awaiting review" },
      }),
    });
    await flush();

    const doc = window.document;
    const monthField = doc.getElementById("submitMonth");
    monthField.value = "2026-10";
    monthField.dispatchEvent(new window.Event("change", { bubbles: true }));
    await flush();
    doc.getElementById("submitTimesheetBtn").click();
    await flush();

    const toast = doc.getElementById("toast");
    expect(toast.textContent).toBe(
      "That month's timesheet is still awaiting review",
    );
    expect(toast.classList.contains("toast--danger")).toBe(true);

    const postCall = window.__fetchCalls.find(
      (call) => call.method === "POST" && call.url === "/api/timesheets",
    );
    expect(JSON.parse(postCall.body).weekStart).toBe("2026-10-01");
  });
});
