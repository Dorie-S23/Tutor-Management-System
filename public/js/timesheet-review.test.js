// timesheet-review.js is the organiser's timesheet review page: the
// status-chip queue with approve/reject/reconsider (via a reason <dialog>),
// the dispute modal and its resolve action, the payroll CSV export, the
// review-summary card, the tutor's claim form rebuilt in Details from the
// frozen entries snapshot, and the PDF action that opens the submitted
// document via a short-lived signed URL. Loads the real timesheet-review.html
// and swaps the script tag for an inline copy (the my-sessions suite
// pattern), stubbing fetch, window.open/print, smooth-scroll and the
// blob-download plumbing, and polyfilling the dialog modal methods jsdom
// doesn't implement. Queue/modal/dispute coverage and the claim-form/PDF
// coverage grew out of two suites written against the same page and were
// folded together here so the page keeps one harness.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "timesheet-review.html"),
  "utf8",
);
const scriptSrc = fs.readFileSync(
  path.join(__dirname, "timesheet-review.js"),
  "utf8",
);
const scriptUrl = pathToFileURL(
  path.join(__dirname, "timesheet-review.js"),
).href;

const PENDING = {
  user_id: "u1",
  week_start: "2026-09-01",
  status: "pending",
  total_hours: 5,
  reviewer_note: null,
  submitted_at: "2026-09-28T10:00:00.000Z",
  users: { name: "Ada Lovelace", email: "ada@wits.ac.za" },
  entries_snapshot: [
    {
      date: "2026-09-03",
      hours: 2,
      start_time: "08:00:00",
      end_time: "10:30:00",
      task_type: "Tutorial",
      subject: "COMS1016A",
      verification_status: "verified",
      notes: "",
    },
    {
      date: "2026-09-05",
      hours: 3,
      task_type: "Lab",
      subject: "COMS1016A",
      verification_status: "flagged",
      notes: "late join",
    },
  ],
};

const APPROVED = {
  user_id: "u2",
  week_start: "2026-09-01",
  status: "approved",
  total_hours: 4,
  reviewer_note: "all good",
  users: { name: "Grace Hopper", email: "grace@wits.ac.za" },
  entries_snapshot: [],
};

const REJECTED = {
  user_id: "u3",
  week_start: "2026-09-01",
  status: "rejected",
  total_hours: 3,
  reviewer_note: "hours look doubled",
  users: { name: "Linus Pakidi", email: "linus@wits.ac.za" },
  entries_snapshot: [],
};

const ALL = [PENDING, APPROVED, REJECTED];

const DISPUTE = {
  id: "d1",
  timesheet_user_id: "u1",
  timesheet_week_start: "2026-09-01",
  message: "Wednesday's hours look doubled",
  created_at: "2026-09-28T10:00:00.000Z",
  users: { name: "Ada Lovelace" },
};

// Profile-page values the claim form fills in a beat after Details opens —
// only u1's record answers; the other tutors' lookups come back not-found.
const PROFILE = {
  name: "Ada Lovelace",
  studentNumber: "1234567",
  email: "ada@wits.ac.za",
  cellPhone: "082 123 4567",
  yearOfStudy: "honours",
};

const SIGNED_PDF_URL =
  "https://fake-supabase.test/storage/v1/object/sign/timesheets/u1/2026-09-01.pdf?token=fake";

function loadPage({
  all = ALL,
  disputes = [DISPUTE],
  submissionsFail = false,
  resolveFails = false,
  pdfUrl = null,
  profile = PROFILE,
  url = "http://localhost/timesheet-review.html",
} = {}) {
  const pageHtml = html
    .replace(/<script[^>]*src="\.\.\/js\/[^"]*"[^>]*><\/script>/g, "")
    .replace(/<script type="module">[\s\S]*?<\/script>/, "")
    .replace(
      "</body>",
      `<script>${scriptSrc}\n//# sourceURL=${scriptUrl}</script></body>`,
    );

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      window.HTMLElement.prototype.scrollIntoView = () => {};
      // jsdom ships the <dialog> element and its open attribute but not the
      // modal methods; the page only needs the attribute flips.
      if (!window.HTMLDialogElement.prototype.showModal) {
        window.HTMLDialogElement.prototype.showModal = function () {
          this.setAttribute("open", "");
        };
        window.HTMLDialogElement.prototype.close = function () {
          this.removeAttribute("open");
        };
      }
      window.URL.createObjectURL = () => "blob:test-1";
      window.URL.revokeObjectURL = () => {};
      // jsdom has no real tabs — record what the PDF action tries to open.
      window.open = (openedUrl, target) => {
        calls.push({ url: String(openedUrl), method: "window.open" });
        return null;
      };
      // jsdom has no print dialog — record the call, snapshotting what the
      // print CSS would see (the body class + the targeted claim sheet).
      window.print = () => {
        const target = window.document.querySelector(".claim-print-target");
        calls.push({
          method: "window.print",
          bodyClass: window.document.body.className,
          targetClass: target ? target.className : null,
        });
      };
      window.fetch = async (fetchUrl, options = {}) => {
        const href = String(fetchUrl);
        const parsed = new URL(href, "http://localhost");
        calls.push({
          url: href,
          method: options.method || "GET",
          body: options.body ? JSON.parse(options.body) : null,
        });

        // The PDF action shares the /api/timesheets prefix with the list
        // call — a null pdfUrl stands for the server's 404 for months
        // filed before the capture feature existed.
        if (parsed.pathname.endsWith("/pdf-url")) {
          if (pdfUrl === null) {
            return {
              ok: false,
              status: 404,
              json: async () => ({ error: "No PDF on file for that month" }),
            };
          }
          return { ok: true, json: async () => ({ url: pdfUrl }) };
        }
        if (parsed.pathname.startsWith("/api/timesheet-disputes")) {
          if (parsed.search === "?resolved=false") {
            return { ok: true, json: async () => disputes };
          }
          // PATCH /api/timesheet-disputes/:id/resolve
          if (resolveFails) return { ok: false, json: async () => ({}) };
          return { ok: true, json: async () => ({}) };
        }
        if (parsed.pathname === "/api/timesheets/payroll-export") {
          return { ok: true, blob: async () => "csv-bytes" };
        }
        if (parsed.pathname === "/api/timesheets") {
          if (submissionsFail) {
            return { ok: false, json: async () => ({ error: "boom" }) };
          }
          const status = parsed.searchParams.get("status");
          if (status === null || status === "") {
            return { ok: true, json: async () => all };
          }
          return {
            ok: true,
            json: async () => all.filter((r) => r.status === status),
          };
        }
        if (parsed.pathname.startsWith("/api/profile/")) {
          return profile
            ? { ok: true, json: async () => profile }
            : { ok: false, json: async () => ({ error: "User not found" }) };
        }
        // PATCH /api/timesheets/:userId/:weekStart
        return { ok: true, json: async () => ({}) };
      };
    },
  });

  return { window: dom.window, document: dom.window.document, calls };
}

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const submitReasonForm = (window, document) =>
  document
    .getElementById("reasonForm")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );

const queueFetches = (calls) =>
  calls.filter(
    (c) => c.method === "GET" && /^\/api\/timesheets\?status=/.test(c.url),
  );

function actionButtons(document, row) {
  return [...row.querySelectorAll(".applicant-actions button")];
}

function openDetails(document) {
  [...document.querySelectorAll("#submissionList button")]
    .find((btn) => btn.textContent === "Details")
    .click();
}

function clickPdf(document) {
  const button = [...document.querySelectorAll("#submissionList button")].find(
    (btn) => btn.textContent === "PDF",
  );
  button.click();
  return button;
}

describe("timesheet-review.js", () => {
  test("boots the summary counts, verify cards and the pending queue", async () => {
    const { document } = loadPage();
    await wait();

    const chipText = (status) =>
      document.querySelector(`.filter-chip[data-status="${status}"]`)
        .textContent;
    expect(chipText("pending")).toBe("Pending (1)");
    expect(chipText("approved")).toBe("Approved (1)");
    expect(chipText("rejected")).toBe("Rejected (1)");
    expect(chipText("")).toBe("All (3)");

    expect(document.getElementById("verifyPendingMeta").textContent).toBe(
      "1 pending",
    );
    expect(document.getElementById("verifyDecidedMeta").textContent).toBe(
      "2 decided",
    );
    expect(document.getElementById("verifyRejectedMeta").textContent).toBe(
      "1 rejected",
    );
    expect(document.getElementById("verifyDisputeMeta").textContent).toBe(
      "1 open dispute",
    );
    expect(document.getElementById("viewDisputesBtn").disabled).toBe(false);

    // The default filter is pending, so only Ada's submission shows — with
    // its dispute pill and dispute button next to the decision actions.
    const rows = document.querySelectorAll("#submissionList li");
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.key).toBe("u1_2026-09-01");
    expect(rows[0].querySelector(".name").textContent).toBe("Ada Lovelace");
    expect(rows[0].querySelector(".role").textContent).toBe("ada@wits.ac.za");
    expect(
      [...rows[0].querySelectorAll(".stamp")].map((s) => s.textContent),
    ).toEqual(["September 2026", "5 hrs"]);
    const pills = [...rows[0].querySelectorAll(".status-pill")].map(
      (p) => p.textContent,
    );
    expect(pills).toContain("pending");
    expect(pills).toContain("disputed");
    expect(actionButtons(document, rows[0]).map((b) => b.textContent)).toEqual([
      "Details",
      "PDF",
      "View dispute",
      "Approve",
      "Reject",
    ]);
  });

  test("Details toggles the entry-level breakdown with verification pills", async () => {
    const { document } = loadPage();
    await wait();

    const detailsBtn = document.querySelector(
      "#submissionList li .applicant-actions button",
    );
    detailsBtn.click();

    const detail = document.querySelector(".submission-detail");
    expect(detail).not.toBeNull();
    const rows = [...detail.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(rows[0]).toEqual([
      "03/09/2026",
      "2",
      "Tutorial",
      "COMS1016A",
      "Verified",
      "",
    ]);
    expect(rows[1][4]).toBe("Flagged");

    detailsBtn.click();
    expect(document.querySelector(".submission-detail")).toBeNull();
  });

  test("Details renders the claim built from the frozen snapshot", async () => {
    const { document } = loadPage();
    await wait();

    openDetails(document);
    await wait(); // let the profile fetch fill the identity block

    const detail = document.querySelector(".submission-detail");

    // The verification table survives alongside the document.
    expect(detail.textContent).toContain("Verified");
    expect(detail.textContent).toContain("Flagged");

    const claim = detail.querySelector(".claim-form");
    expect(claim).not.toBeNull();
    expect(
      detail.querySelector(".claim-doc-toolbar").classList.contains("no-print"),
    ).toBe(true);

    // Identity block: profile values plus the locked academic level.
    expect(claim.querySelector('[data-claim="fullName"]').textContent).toBe(
      "Ada Lovelace",
    );
    expect(claim.querySelector('[data-claim="studentNo"]').textContent).toBe(
      "1234567",
    );
    expect(claim.querySelector('[data-claim="email"]').textContent).toBe(
      "ada@wits.ac.za",
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
      "28/09/2026",
    );

    // Task rows mirror the tutor's claim formatting; blank rows pad the
    // printed form out to 15.
    const rows = claim.querySelectorAll('[data-claim="rows"] tr');
    expect(rows).toHaveLength(15);
    expect([...rows[0].cells].map((td) => td.textContent)).toEqual([
      "03/09/2026",
      "08:00-10:30",
      "2hrs",
      "Tutorial – COMS1016A",
      "",
      "",
    ]);
    expect([...rows[1].cells].map((td) => td.textContent)).toEqual([
      "05/09/2026",
      "",
      "3hrs",
      "Lab – COMS1016A",
      "",
      "",
    ]);
    expect(rows[2].classList.contains("claim-blank-row")).toBe(true);

    // Totals: hours from the snapshot; payroll and amount stay blank.
    expect(claim.querySelector('[data-claim="totalHours"]').textContent).toBe(
      "5",
    );
    expect(claim.querySelector('[data-claim="payrollNo"]').textContent).toBe(
      "",
    );
    expect(claim.querySelector('[data-claim="totalAmount"]').textContent).toBe(
      "",
    );
  });

  test("a failed profile fetch still shows the claim from the submission row", async () => {
    const { document } = loadPage({ profile: null });
    await wait();

    openDetails(document);
    await wait();

    const claim = document.querySelector(".submission-detail .claim-form");
    expect(claim.querySelector('[data-claim="fullName"]').textContent).toBe(
      "Ada Lovelace",
    );
    expect(claim.querySelector('[data-claim="email"]').textContent).toBe(
      "ada@wits.ac.za",
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
      "5",
    );
  });

  test("entries without logged times leave the times cell blank", async () => {
    const noTimes = {
      ...PENDING,
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
    const { document } = loadPage({ all: [noTimes] });
    await wait();

    openDetails(document);
    await wait();

    const rows = document.querySelectorAll(
      '.submission-detail [data-claim="rows"] tr',
    );
    expect([...rows[0].cells].map((td) => td.textContent)).toEqual([
      "10/09/2026",
      "",
      "3hrs",
      "Admin",
      "",
      "",
    ]);
  });

  test("Print / Save as PDF targets only the open claim sheet", async () => {
    const { document, calls } = loadPage();
    await wait();

    openDetails(document);
    await wait();

    document.querySelector(".claim-print-btn").click();

    // While printing, the body is flagged and the claim sheet is the target
    // of the body.claim-printing rules in app.css — and the flags are
    // cleaned up right after.
    const print = calls.find((c) => c.method === "window.print");
    expect(print).toBeDefined();
    expect(print.bodyClass).toContain("claim-printing");
    expect(print.targetClass).toContain("claim-print-target");
    expect(document.body.className).toBe("");
    expect(document.querySelector(".claim-print-target")).toBeNull();
  });

  test("Approve opens the modal, submits an optional note, PATCHes and reloads", async () => {
    const { window, document, calls } = loadPage();
    await wait();
    const patchCallsBefore = calls.filter(
      (c) => c.method === "GET" && c.url.includes("status="),
    ).length;

    actionButtons(document, document.querySelector("#submissionList li"))
      .find((b) => b.textContent === "Approve")
      .click();

    const modal = document.getElementById("reasonModal");
    expect(modal.open).toBe(true);
    expect(document.getElementById("reasonModalHeading").textContent).toBe(
      "Approve timesheet",
    );
    expect(document.getElementById("reasonFieldLabel").textContent).toBe(
      "Note (optional)",
    );
    expect(document.getElementById("reasonSubmitBtn").textContent).toBe(
      "Approve",
    );

    document.getElementById("reasonInput").value = "matches the log";
    submitReasonForm(window, document);
    await wait();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.url).toBe("/api/timesheets/u1/2026-09-01");
    expect(patch.body).toEqual({
      status: "approved",
      reviewerNote: "matches the log",
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Ada Lovelace's timesheet approved",
    );
    expect(modal.open).toBe(false);
    // The queue refetched its pending list after the decision.
    expect(queueFetches(calls).length).toBe(patchCallsBefore + 1);
  });

  test("Reject demands a reason before it PATCHes", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    actionButtons(document, document.querySelector("#submissionList li"))
      .find((b) => b.textContent === "Reject")
      .click();

    submitReasonForm(window, document);
    const formError = document.getElementById("reasonFormError");
    expect(formError.hidden).toBe(false);
    expect(formError.textContent).toBe("A reason is required.");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    document.getElementById("reasonInput").value = "hours doubled";
    submitReasonForm(window, document);
    await wait();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.body).toEqual({
      status: "rejected",
      reviewerNote: "hours doubled",
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Ada Lovelace's timesheet rejected",
    );
    expect(document.getElementById("reasonModal").open).toBe(false);
  });

  test("decided rows show their note and offer Reconsider back to pending", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    document.querySelector('.filter-chip[data-status="approved"]').click();
    await wait();

    const row = document.querySelector("#submissionList li");
    expect(row.dataset.key).toBe("u2_2026-09-01");
    expect(row.querySelector(".review-note").textContent).toBe(
      "Note: all good",
    );

    actionButtons(document, row)
      .find((b) => b.textContent === "Reconsider")
      .click();
    await wait();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch.url).toBe("/api/timesheets/u2/2026-09-01");
    expect(patch.body).toEqual({
      status: "pending",
      reviewerNote: undefined,
    });
    expect(document.getElementById("toast").textContent).toBe(
      "Grace Hopper's timesheet moved back to pending",
    );
  });

  test("the row's View dispute opens the modal and resolving PATCHes it", async () => {
    const { document, calls } = loadPage();
    await wait();

    actionButtons(document, document.querySelector("#submissionList li"))
      .find((b) => b.textContent === "View dispute")
      .click();

    const modal = document.getElementById("disputeModal");
    expect(modal.open).toBe(true);
    expect(document.getElementById("disputeModalHeading").textContent).toBe(
      "Dispute",
    );
    expect(document.getElementById("disputeModalBody").textContent).toContain(
      "Wednesday's hours look doubled",
    );

    document.getElementById("disputeResolveBtn").click();
    await wait();

    expect(
      calls.some(
        (c) =>
          c.method === "PATCH" &&
          c.url === "/api/timesheet-disputes/d1/resolve",
      ),
    ).toBe(true);
    expect(document.getElementById("toast").textContent).toBe(
      "Dispute marked resolved.",
    );
    expect(modal.open).toBe(false);
  });

  test("a failed resolve keeps the modal open and toasts", async () => {
    const { document } = loadPage({ resolveFails: true });
    await wait();

    actionButtons(document, document.querySelector("#submissionList li"))
      .find((b) => b.textContent === "View dispute")
      .click();
    document.getElementById("disputeResolveBtn").click();
    await wait();

    expect(document.getElementById("toast").textContent).toBe(
      "Couldn't resolve one or more disputes.",
    );
    expect(document.getElementById("disputeModal").open).toBe(true);
  });

  test("the summary card's View disputes opens every open dispute at once", async () => {
    const { document, calls } = loadPage({
      disputes: [
        DISPUTE,
        { ...DISPUTE, id: "d2", message: "The Monday lab wasn't held" },
      ],
    });
    await wait();

    document.getElementById("viewDisputesBtn").click();

    const modal = document.getElementById("disputeModal");
    expect(modal.open).toBe(true);
    expect(document.getElementById("disputeModalHeading").textContent).toBe(
      "Open disputes",
    );
    expect(document.getElementById("disputeModalBody").textContent).toContain(
      "The Monday lab wasn't held",
    );

    document.getElementById("disputeResolveBtn").click();
    await wait();

    const resolves = calls.filter(
      (c) =>
        c.method === "PATCH" &&
        c.url.includes("timesheet-disputes") &&
        c.url.includes("/resolve"),
    );
    expect(resolves).toHaveLength(2);
  });

  test("filter chips drive the queue fetch, and the summary button refilters", async () => {
    const { document, calls } = loadPage();
    await wait();

    document.querySelector('.filter-chip[data-status=""]').click();
    await wait();

    expect(
      calls.some((c) => c.method === "GET" && c.url === "/api/timesheets"),
    ).toBe(true);
    const rows = document.querySelectorAll("#submissionList li");
    expect(rows).toHaveLength(3);
    // Exactly the All chip is active now.
    const activeChips = [...document.querySelectorAll(".filter-chip")]
      .filter((c) => c.classList.contains("is-active"))
      .map((c) => c.dataset.status);
    expect(activeChips).toEqual([""]);

    document.getElementById("reviewPendingBtn").click();
    await wait();

    expect(
      calls.some(
        (c) => c.method === "GET" && c.url === "/api/timesheets?status=pending",
      ),
    ).toBe(true);
    expect(
      document
        .querySelector('.filter-chip[data-status="pending"]')
        .classList.contains("is-active"),
    ).toBe(true);
  });

  test("payroll export downloads a dated CSV blob", async () => {
    const { window, document, calls } = loadPage();
    await wait();

    const revocations = [];
    window.URL.revokeObjectURL = (u) => revocations.push(u);
    // The page appends the anchor, clicks it and removes it synchronously,
    // so the click is intercepted instead of looking for a link afterwards.
    const downloads = [];
    window.HTMLAnchorElement.prototype.click = function () {
      downloads.push({ href: this.href, download: this.download });
    };

    document.getElementById("exportPayrollBtn").click();
    await wait();

    expect(calls.some((c) => c.url === "/api/timesheets/payroll-export")).toBe(
      true,
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0].href).toBe("blob:test-1");
    expect(downloads[0].download).toMatch(
      /^payroll-export-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(revocations).toEqual(["blob:test-1"]);
  });

  test("a failed submissions load toasts and leaves the queue empty", async () => {
    const { document } = loadPage({ submissionsFail: true });
    await wait();

    expect(document.getElementById("toast").textContent).toBe(
      "Couldn't load timesheets.",
    );
    expect(document.querySelectorAll("#submissionList li")).toHaveLength(0);
  });

  test("a highlight deep-link widens the filter to all and flashes the row", async () => {
    const { document } = loadPage({
      url: "http://localhost/timesheet-review.html?highlight=u2_2026-09-01",
    });
    await wait();

    // The approved row wouldn't show under the default pending filter.
    expect(document.getElementById("statusFilter").value).toBe("");
    const row = document.querySelector('li[data-key="u2_2026-09-01"]');
    expect(row.classList.contains("search-highlight")).toBe(true);
  });

  test("clicking PDF fetches the signed URL and opens it in a new tab", async () => {
    const { document, calls } = loadPage({ pdfUrl: SIGNED_PDF_URL });
    await wait();

    const button = clickPdf(document);
    // The fetch is in flight — the button is locked so it can't be queued
    // twice.
    expect(button.disabled).toBe(true);
    await wait();

    expect(
      calls.some(
        (c) =>
          c.method === "GET" &&
          c.url === "/api/timesheets/u1/2026-09-01/pdf-url",
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === "window.open" && c.url === SIGNED_PDF_URL),
    ).toBe(true);
    expect(button.disabled).toBe(false);
  });

  test("a month with no PDF on file toasts the fallback and opens nothing", async () => {
    const { document, calls } = loadPage();
    await wait();

    const button = clickPdf(document);
    await wait();

    const toast = document.getElementById("toast");
    expect(toast.textContent).toBe(
      "No PDF on file for that month — use Details to view or print the claim.",
    );
    expect(toast.classList.contains("show")).toBe(true);
    expect(calls.some((c) => c.method === "window.open")).toBe(false);
    expect(button.disabled).toBe(false);
  });

  test("the PDF action appears on both pending and approved rows", async () => {
    const { document } = loadPage();
    await wait();

    // The default queue only lists pending rows; widen to all first.
    document.querySelector('.filter-chip[data-status=""]').click();
    await wait();

    // Widening to all lists the pending, approved and rejected rows —
    // every one of them carries the PDF action.
    const actionGroups = [
      ...document.querySelectorAll("#submissionList .applicant-actions"),
    ];
    expect(actionGroups).toHaveLength(3);
    for (const group of actionGroups) {
      const labels = [...group.querySelectorAll("button")].map(
        (btn) => btn.textContent,
      );
      expect(labels).toContain("PDF");
    }
  });
});
