// timesheet-review.js is a plain browser script driving the organiser's
// submission queue; its Details action also rebuilds the tutor's claim form
// from the frozen snapshot, and its PDF action opens the document the tutor
// uploaded at submit time via a short-lived signed URL — same jsdom approach
// as organiser-requests.test.js: load the real HTML and the real script into
// a jsdom window with a stubbed fetch, and assert on the DOM it builds.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const pageHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "timesheet-review.html"),
  "utf8",
);
const pageJs = fs.readFileSync(
  path.join(__dirname, "timesheet-review.js"),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROFILE = {
  id: "t1",
  name: "Thandi Tutor",
  email: "thandi@wits.ac.za",
  studentNumber: "1234567",
  cellPhone: "082 123 4567",
  role: "tutor",
  yearOfStudy: "honours",
};

const SUBMISSION = {
  user_id: "t1",
  week_start: "2026-09-01",
  status: "pending",
  total_hours: 6.5,
  submitted_at: "2026-10-02T08:30:00.000Z",
  reviewer_note: null,
  entries_snapshot: [
    {
      date: "2026-09-03",
      hours: 2.5,
      start_time: "08:00:00",
      end_time: "10:30:00",
      task_type: "Tutoring",
      subject: "COS132",
      notes: "",
      verification_status: "verified",
    },
    {
      date: "2026-09-08",
      hours: 4,
      start_time: "13:00:00",
      end_time: "17:00:00",
      task_type: "Marking",
      subject: "COS132",
      notes: "",
      verification_status: "pending",
    },
  ],
  users: { name: "Thandi Tutor", email: "thandi@wits.ac.za" },
};

const SIGNED_PDF_URL =
  "https://fake-supabase.test/storage/v1/object/sign/transcripts/t1/timesheets/2026-09-01.pdf?token=fake-token";

function respondWith({
  submissions = [SUBMISSION],
  profile = PROFILE,
  pdfUrl = null,
} = {}) {
  return (url) => {
    // The PDF action shares the /api/timesheets prefix with the list call,
    // so its signed-URL lookup is branched here, before the catch-all —
    // null means the server has nothing stored for the month (404), which
    // is what pre-capture months answer.
    if (url.includes("/pdf-url")) {
      return pdfUrl === null
        ? Promise.resolve({
            ok: false,
            status: 404,
            json: async () => ({ error: "No PDF on file for that month" }),
          })
        : Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ url: pdfUrl, expiresIn: 300 }),
          });
    }
    if (url.startsWith("/api/timesheets")) {
      return Promise.resolve({ ok: true, json: async () => submissions });
    }
    if (url.startsWith("/api/timesheet-disputes")) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    if (url.startsWith("/api/profile/")) {
      return profile
        ? Promise.resolve({ ok: true, json: async () => profile })
        : Promise.resolve({
            ok: false,
            json: async () => ({ error: "User not found" }),
          });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
}

let currentDom = null;

function loadPage(respond) {
  // Inline the script under test (with its real sourceURL so coverage
  // attribution matches the other jsdom suites); the page's other scripts
  // (user badge, search, notifications, logout, the storage module guard)
  // aren't what this suite exercises, so they're dropped like the
  // organiser-requests suite does.
  const html = pageHtml
    .replace(
      '<script src="../js/timesheet-review.js"></script>',
      `<script>${pageJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "timesheet-review.js")).href}</script>`,
    )
    .replace('<script src="../js/user-badge.js"></script>', "")
    .replace('<script src="../js/universal-search.js"></script>', "")
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "")
    .replace(/<script type="module">[\s\S]*?<\/script>/, "");

  const calls = [];
  const printed = [];
  const opened = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/timesheet-review.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, opts) => {
        calls.push({ url: String(url), opts });
        return respond(String(url), opts);
      };
      // jsdom has no real tabs — record what the PDF action tries to open.
      window.open = (url, target) => {
        opened.push({ url, target });
        return null;
      };
      // jsdom has no print dialog — record the call, snapshotting what the
      // print CSS would see (the body class + the targeted claim sheet).
      window.print = () => {
        const target = window.document.querySelector(".claim-print-target");
        printed.push({
          bodyClass: window.document.body.className,
          targetClass: target ? target.className : null,
        });
      };
    },
  });

  currentDom = dom;

  return { window: dom.window, calls, printed, opened };
}

function openDetails(window) {
  const button = [
    ...window.document.querySelectorAll("#submissionList button"),
  ].find((btn) => btn.textContent === "Details");
  button.click();
  return button;
}

function clickPdf(window) {
  const button = [
    ...window.document.querySelectorAll("#submissionList button"),
  ].find((btn) => btn.textContent === "PDF");
  button.click();
  return button;
}

// Boot now starts the page's background-sync intervals — close each test's
// window so they don't fire against a torn-down document and hang the runner.
afterEach(() => {
  currentDom?.window.close();
  currentDom = null;
});

describe("timesheet-review page — Details shows the tutor's claim form", () => {
  test("Details renders the claim built from the frozen snapshot", async () => {
    const { window } = loadPage(respondWith());
    await flush();
    const doc = window.document;

    openDetails(window);
    await flush(); // let the profile fetch fill the identity block

    const detail = doc.querySelector(".submission-detail");
    expect(detail).toBeTruthy();

    // The verification table survives alongside the document.
    expect(detail.querySelector("table.tutors-table")).toBeTruthy();
    expect(detail.textContent).toContain("Verified");
    expect(detail.textContent).toContain("Pending");

    const claim = detail.querySelector(".claim-form");
    expect(claim).toBeTruthy();
    expect(
      detail.querySelector(".claim-doc-toolbar").classList.contains("no-print"),
    ).toBe(true);

    // Identity block: profile values plus the locked academic level.
    expect(claim.querySelector('[data-claim="fullName"]').textContent).toBe(
      "Thandi Tutor",
    );
    expect(claim.querySelector('[data-claim="studentNo"]').textContent).toBe(
      "1234567",
    );
    expect(claim.querySelector('[data-claim="email"]').textContent).toBe(
      "thandi@wits.ac.za",
    );
    expect(claim.querySelector('[data-claim="cellPhone"]').textContent).toBe(
      "082 123 4567",
    );
    expect(claim.querySelector('[data-claim="yearOfStudy"]').textContent).toBe(
      "Honours",
    );
    expect(
      claim
        .querySelector('.claim-year-option[data-year="honours"]')
        .classList.contains("is-selected"),
    ).toBe(true);
    expect(
      claim
        .querySelector('.claim-year-option[data-year="masters"]')
        .classList.contains("is-selected"),
    ).toBe(false);

    // Frozen stamps: header year and signature date come from submitted_at.
    expect(claim.querySelector('[data-claim="year"]').textContent).toBe("2026");
    expect(claim.querySelector('[data-claim="signDate"]').textContent).toBe(
      "02/10/2026",
    );

    // Task rows mirror the tutor's claim formatting; blank rows pad the
    // printed form out to 15.
    const rows = claim.querySelectorAll('[data-claim="rows"] tr');
    expect(rows).toHaveLength(15);
    const firstRow = [...rows[0].cells].map((td) => td.textContent);
    expect(firstRow).toEqual([
      "03/09/2026",
      "08:00-10:30",
      "2.5hrs",
      "Tutoring – COS132",
      "",
      "",
    ]);
    const secondRow = [...rows[1].cells].map((td) => td.textContent);
    expect(secondRow).toEqual([
      "08/09/2026",
      "13:00-17:00",
      "4hrs",
      "Marking – COS132",
      "",
      "",
    ]);
    expect(rows[2].classList.contains("claim-blank-row")).toBe(true);

    // Totals: hours from the snapshot; payroll and amount stay blank.
    expect(claim.querySelector('[data-claim="totalHours"]').textContent).toBe(
      "6.5",
    );
    expect(claim.querySelector('[data-claim="payrollNo"]').textContent).toBe(
      "",
    );
    expect(claim.querySelector('[data-claim="totalAmount"]').textContent).toBe(
      "",
    );
  });

  test("a second Details click closes the claim again", async () => {
    const { window } = loadPage(respondWith());
    await flush();
    const doc = window.document;

    openDetails(window);
    await flush();
    expect(doc.querySelector(".submission-detail")).toBeTruthy();

    openDetails(window);
    expect(doc.querySelector(".submission-detail")).toBeNull();
  });

  test("a failed profile fetch still shows the claim from the submission row", async () => {
    const { window } = loadPage(respondWith({ profile: null }));
    await flush();
    const doc = window.document;

    openDetails(window);
    await flush();

    const claim = doc.querySelector(".submission-detail .claim-form");
    expect(claim.querySelector('[data-claim="fullName"]').textContent).toBe(
      "Thandi Tutor",
    );
    expect(claim.querySelector('[data-claim="email"]').textContent).toBe(
      "thandi@wits.ac.za",
    );
    expect(claim.querySelector('[data-claim="studentNo"]').textContent).toBe(
      "",
    );
    expect(claim.querySelector('[data-claim="cellPhone"]').textContent).toBe(
      "",
    );
    expect(claim.querySelector(".claim-year-option.is-selected")).toBeNull();
    // The document still renders the snapshot's hours.
    expect(claim.querySelector('[data-claim="totalHours"]').textContent).toBe(
      "6.5",
    );
  });

  test("entries without logged times leave the times cell blank", async () => {
    const noTimes = {
      ...SUBMISSION,
      entries_snapshot: [
        {
          date: "2026-09-10",
          hours: 3,
          task_type: "Admin",
          subject: "",
          notes: "",
          verification_status: "pending",
        },
      ],
    };
    const { window } = loadPage(respondWith({ submissions: [noTimes] }));
    await flush();

    openDetails(window);
    await flush();

    const rows = window.document.querySelectorAll(
      '.submission-detail [data-claim="rows"] tr',
    );
    const firstRow = [...rows[0].cells].map((td) => td.textContent);
    expect(firstRow).toEqual(["10/09/2026", "", "3hrs", "Admin", "", ""]);
  });

  test("Print / Save as PDF targets only the open claim sheet", async () => {
    const { window, printed } = loadPage(respondWith());
    await flush();
    const doc = window.document;

    openDetails(window);
    await flush();

    doc.querySelector(".claim-print-btn").click();

    // While printing, the body is flagged and the claim sheet is the target
    // of the body.claim-printing rules in app.css.
    expect(printed).toHaveLength(1);
    expect(printed[0].bodyClass).toContain("claim-printing");
    expect(printed[0].targetClass).toContain("claim-print-target");

    // ...and the flags are cleaned up right after.
    expect(doc.body.className).toBe("");
    expect(doc.querySelector(".claim-print-target")).toBeNull();
  });
});

describe("timesheet-review page — PDF action", () => {
  test("clicking PDF fetches the signed URL and opens it in a new tab", async () => {
    const { window, calls, opened } = loadPage(
      respondWith({ pdfUrl: SIGNED_PDF_URL }),
    );
    await flush();

    const button = clickPdf(window);
    // The fetch is in flight — the button is locked so it can't be queued
    // twice.
    expect(button.disabled).toBe(true);
    await flush();

    expect(
      calls
        .map((call) => call.url)
        .includes("/api/timesheets/t1/2026-09-01/pdf-url"),
    ).toBe(true);
    expect(opened).toEqual([{ url: SIGNED_PDF_URL, target: "_blank" }]);
    expect(button.disabled).toBe(false);
  });

  test("a month with no PDF on file toasts the fallback and opens nothing", async () => {
    // The default respondWith has no signed URL — the server's 404 for
    // months filed before the capture feature existed.
    const { window, opened } = loadPage(respondWith());
    await flush();

    const button = clickPdf(window);
    await flush();

    const toast = window.document.getElementById("toast");
    expect(toast.textContent).toBe(
      "No PDF on file for that month — use Details to view or print the claim.",
    );
    expect(toast.classList.contains("show")).toBe(true);
    expect(opened).toHaveLength(0);
    expect(button.disabled).toBe(false);
  });

  test("the PDF action appears on both pending and approved rows", async () => {
    const approved = {
      ...SUBMISSION,
      user_id: "t2",
      week_start: "2026-08-01",
      status: "approved",
    };
    const { window } = loadPage(
      respondWith({ submissions: [SUBMISSION, approved] }),
    );
    await flush();

    const actionGroups = [
      ...window.document.querySelectorAll("#submissionList .applicant-actions"),
    ];
    expect(actionGroups).toHaveLength(2);
    for (const group of actionGroups) {
      const labels = [...group.querySelectorAll("button")].map(
        (btn) => btn.textContent,
      );
      expect(labels).toContain("PDF");
    }
  });
});
