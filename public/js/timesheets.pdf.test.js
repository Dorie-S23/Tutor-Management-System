// Submitting a month now renders the claim form to a PDF in the browser
// (stubbed html2canvas + jsPDF standing in for the CDN libraries) and
// uploads it BEFORE the submission POST — a failed capture or upload blocks
// the submission, retryably. Loads the real storage.js + timesheets.js
// sources into jsdom, the same harness style as timesheets.resubmit.test.js.
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
  <p class="hint" id="details-sync-hint" hidden></p>
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
      <span class="claim-year-option" data-year="honours"></span>
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

// The September entry is the one being submitted; the August one shares the
// live preview (the default range) but must stay out of the captured PDF.
const SEPTEMBER_ENTRIES = [
  { date: "2026-09-03", hours: 2 },
  { date: "2026-08-20", hours: 9 },
];

function renderPage({
  submissions = [],
  entries = [],
  postTimesheet,
  profile = PROFILE,
  uploadPdf,
  captureFails = false,
} = {}) {
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
        window.__fetchCalls.push({
          url: requestUrl,
          method,
          body: init?.body,
          headers: init?.headers,
        });

        if (requestUrl.startsWith("/api/profile/")) {
          return profile
            ? Promise.resolve({
                ok: true,
                status: 200,
                json: async () => profile,
              })
            : Promise.resolve({
                ok: false,
                status: 404,
                json: async () => ({ error: "User not found" }),
              });
        }
        if (requestUrl.startsWith("/api/hour-entries")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () =>
              entries.map((e) => ({
                start_time: "",
                end_time: "",
                task_type: "Tutoring",
                subject: "COS132",
                notes: "",
                ...e,
              })),
          });
        }
        // The claim PDF upload — checked before the /api/timesheets
        // catch-all, whose prefix it shares.
        if (requestUrl.includes("/pdf")) {
          const result = uploadPdf
            ? uploadPdf(requestUrl)
            : { status: 201, body: { uploaded: true } };
          return Promise.resolve({
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => result.body,
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
      // The CDN libraries can't load in jsdom — stand-ins record what the
      // page asked them for and hand back something pdf-shaped.
      window.__captured = null;
      window.__captureOptions = null;
      window.__pdfOptions = null;
      window.__pdfImages = [];
      window.html2canvas = (el, opts) => {
        window.__captured = el;
        window.__captureOptions = opts;
        return captureFails
          ? Promise.reject(new Error("capture exploded"))
          : Promise.resolve({ width: 800, height: 1200 });
      };
      window.jspdf = {
        jsPDF: class {
          constructor(options) {
            window.__pdfOptions = options;
          }
          addImage(...args) {
            window.__pdfImages.push(args);
          }
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
// The whole submit flow is promise chains (the fake fetches and library
// stand-ins resolve in microtasks), so a couple of macrotask turns settle it.
const settle = async () => {
  await flush();
  await flush();
};

function pickMonth(window, value) {
  const monthField = window.document.getElementById("submitMonth");
  monthField.value = value;
  monthField.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function pdfPosts(window) {
  return window.__fetchCalls.filter(
    (call) => call.method === "POST" && call.url.includes("/pdf"),
  );
}

function submitPosts(window) {
  return window.__fetchCalls.filter(
    (call) => call.method === "POST" && call.url === "/api/timesheets",
  );
}

describe("submitting renders and uploads the claim PDF", () => {
  test("the PDF upload goes up before the submission, carrying the month's claim", async () => {
    const window = renderPage({ entries: SEPTEMBER_ENTRIES });
    await flush();

    pickMonth(window, "2026-09");
    await flush();
    window.document.getElementById("submitTimesheetBtn").click();
    await settle();

    // The PDF POST came first, as a real application/pdf body.
    const pdfs = pdfPosts(window);
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0].url).toBe("/api/timesheets/tutor-1/2026-09-01/pdf");
    expect(pdfs[0].headers).toEqual({ "Content-Type": "application/pdf" });
    expect(pdfs[0].body.type).toBe("application/pdf");
    const submits = submitPosts(window);
    expect(submits).toHaveLength(1);
    expect(window.__fetchCalls.indexOf(pdfs[0])).toBeLessThan(
      window.__fetchCalls.indexOf(submits[0]),
    );
    expect(JSON.parse(submits[0].body).weekStart).toBe("2026-09-01");

    // What got captured: the off-screen clone filled with the Profile
    // page's identity and September's rows only — the August entry the
    // preview was also showing is left out — then cleaned up again.
    const captured = window.__captured;
    expect(captured).toBeTruthy();
    expect(captured.closest("body")).toBeNull();
    expect(captured.textContent).toContain("Thandi Tutor");
    expect(captured.textContent).toContain("03/09/2026");
    expect(captured.textContent).not.toContain("20/08/2026");
    expect(captured.textContent).toContain("30/09/2026"); // signed on month end
    expect(window.__captureOptions).toMatchObject({
      scale: 2,
      backgroundColor: "#ffffff",
    });

    // One PDF page, exactly as tall as the captured form.
    expect(window.__pdfImages).toHaveLength(1);
    expect(window.__pdfOptions).toMatchObject({
      unit: "px",
      format: [800, 1200],
    });

    expect(window.document.getElementById("toast").textContent).toBe(
      "Timesheet submitted for approval.",
    );
    expect(
      window.document.getElementById("submitTimesheetBtn").textContent,
    ).toBe("Submit for approval");
  });

  test("a failed capture blocks the submission, retryably", async () => {
    const window = renderPage({
      entries: SEPTEMBER_ENTRIES,
      captureFails: true,
    });
    await flush();

    pickMonth(window, "2026-09");
    await flush();
    const btn = window.document.getElementById("submitTimesheetBtn");
    btn.click();
    await settle();

    expect(pdfPosts(window)).toHaveLength(0);
    expect(submitPosts(window)).toHaveLength(0);
    const toast = window.document.getElementById("toast");
    expect(toast.textContent).toBe("capture exploded");
    expect(toast.classList.contains("toast--danger")).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Submit for approval");
  });

  test("an upload failure surfaces the server's message and blocks the submission", async () => {
    const window = renderPage({
      entries: SEPTEMBER_ENTRIES,
      uploadPdf: () => ({
        status: 503,
        body: {
          error: "Timesheet storage bucket is missing in the Supabase project.",
        },
      }),
    });
    await flush();

    pickMonth(window, "2026-09");
    await flush();
    window.document.getElementById("submitTimesheetBtn").click();
    await settle();

    expect(pdfPosts(window)).toHaveLength(1);
    // The capture clone is cleaned up even when the upload fails.
    expect(window.__captured.closest("body")).toBeNull();
    expect(submitPosts(window)).toHaveLength(0);
    const toast = window.document.getElementById("toast");
    expect(toast.textContent).toBe(
      "Timesheet storage bucket is missing in the Supabase project.",
    );
    expect(toast.classList.contains("toast--danger")).toBe(true);
  });

  test("without claim identity, submission is refused before anything is sent", async () => {
    const window = renderPage({ profile: null, entries: SEPTEMBER_ENTRIES });
    await flush();

    pickMonth(window, "2026-09");
    await flush();
    window.document.getElementById("submitTimesheetBtn").click();
    await settle();

    expect(pdfPosts(window)).toHaveLength(0);
    expect(submitPosts(window)).toHaveLength(0);
    const toast = window.document.getElementById("toast");
    expect(toast.textContent).toBe("Complete your details before submitting.");
    expect(toast.classList.contains("toast--danger")).toBe(true);
  });
});
