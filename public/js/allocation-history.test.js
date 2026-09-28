// allocation-history.js is a plain classic script (no imports), same as
// my-sessions.js — loaded as real HTML + JS into jsdom and driven through
// real fetch/click calls rather than unit-tested in isolation.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "allocation-history.html"),
  "utf8",
);
const scriptSrc = fs.readFileSync(
  path.join(__dirname, "allocation-history.js"),
  "utf8",
);

function loadPage({
  drafts = [],
  auditLog = [],
  compare = null,
  publishResult = null,
  confirmReturns = true,
} = {}) {
  const pageHtml = html
    .replace(
      '<script src="../js/allocation-history.js"></script>',
      `<script>${scriptSrc}</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/allocation-history.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom ships HTMLDialogElement but not its modal API (showModal/close
      // throw "not implemented") — stub just enough for the compare modal.
      window.HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "");
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open");
      };
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "organiser-1", role: "organiser" }),
      );
      window.confirm = () => confirmReturns;
      window.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        const u = String(url);
        if (u.includes("/api/allocation-drafts") && u.includes("/restore")) {
          return {
            ok: true,
            json: async () => ({
              draft: { id: 1, status: "reverted" },
              results: [{ applicationId: "app-1", success: true }],
            }),
          };
        }
        if (u.includes("/api/allocation-drafts") && u.includes("/compare")) {
          return { ok: true, json: async () => compare };
        }
        if (u.includes("/api/allocation-drafts") && u.includes("/publish")) {
          return { ok: true, json: async () => publishResult };
        }
        if (u.includes("/api/allocation-drafts")) {
          return { ok: true, json: async () => drafts };
        }
        if (u.includes("/api/audit-log")) {
          return { ok: true, json: async () => auditLog };
        }
        return { ok: true, json: async () => [] };
      };
    },
  });

  return { window: dom.window, calls };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("allocation-history.js", () => {
  test("shows empty-state copy for both lists when there's nothing", async () => {
    const { window } = loadPage();
    await wait();

    expect(window.document.getElementById("draftsList").textContent).toContain(
      "No auto allocation has been run yet.",
    );
    expect(window.document.getElementById("historyList").textContent).toContain(
      "No changes recorded yet.",
    );
  });

  test("renders a Restore button on published runs and Compare & publish on draft ones", async () => {
    const { window } = loadPage({
      drafts: [
        {
          id: 1,
          name: "Run one",
          status: "published",
          assignmentCount: 3,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T01:00:00Z",
        },
        {
          id: 2,
          name: "Run two",
          status: "draft",
          assignmentCount: 1,
          created_at: "2026-01-02T00:00:00Z",
        },
        {
          id: 3,
          name: "Run three",
          status: "reverted",
          assignmentCount: 1,
          created_at: "2026-01-03T00:00:00Z",
        },
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll("#draftsList article");
    expect(cards).toHaveLength(3);

    const published = Array.from(cards).find((c) =>
      c.textContent.includes("Run one"),
    );
    const draft = Array.from(cards).find((c) =>
      c.textContent.includes("Run two"),
    );
    const reverted = Array.from(cards).find((c) =>
      c.textContent.includes("Run three"),
    );

    expect(published.querySelector("button")?.textContent).toBe("Restore");
    expect(draft.querySelector("button")?.textContent).toBe(
      "Compare & publish",
    );
    expect(reverted.querySelector("button")).toBeNull();
  });

  test("renders change history entries with actor and action", async () => {
    const { window } = loadPage({
      auditLog: [
        {
          id: 1,
          entity_type: "tutor_subject_preference",
          entity_id: "app-1",
          action: "approved",
          actor_id: "organiser-1",
          created_at: "2026-01-01T00:00:00Z",
          users: { name: "Organiser One" },
        },
      ],
    });
    await wait();

    const text = window.document.getElementById("historyList").textContent;
    expect(text).toContain("tutor_subject_preference app-1");
    expect(text).toContain("Organiser One");
    expect(text).toContain("approved");
  });

  test("restoring a draft calls the restore endpoint and refreshes both lists", async () => {
    const { window, calls } = loadPage({
      drafts: [
        {
          id: 1,
          name: "Run one",
          status: "published",
          assignmentCount: 1,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    await wait();

    window.document.querySelector("#draftsList article button").click();
    await wait();

    const restoreCall = calls.find((c) => c.url.includes("/restore"));
    expect(restoreCall).toBeTruthy();
    expect(JSON.parse(restoreCall.opts.body)).toEqual({
      organiserId: "organiser-1",
    });

    // Refreshed after restoring — drafts/audit-log get fetched again.
    const draftFetches = calls.filter(
      (c) =>
        c.url.includes("/api/allocation-drafts") && !c.url.includes("/restore"),
    );
    expect(draftFetches.length).toBeGreaterThanOrEqual(2);
  });

  test("declining the confirm dialog doesn't call restore", async () => {
    const { window, calls } = loadPage({
      drafts: [
        {
          id: 1,
          name: "Run one",
          status: "published",
          assignmentCount: 1,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      confirmReturns: false,
    });
    await wait();

    window.document.querySelector("#draftsList article button").click();
    await wait();

    expect(calls.find((c) => c.url.includes("/restore"))).toBeUndefined();
  });

  test("compare & publish re-opens a run against the current allocation", async () => {
    const { window, calls } = loadPage({
      drafts: [
        {
          id: 2,
          name: "Run two",
          status: "draft",
          assignmentCount: 2,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      compare: {
        draft: { id: 2, status: "draft" },
        summary: { willApply: 1, cannotApply: 1 },
        assignments: [
          {
            id: 100,
            tutor_id: "t1",
            course_id: 10,
            willApply: true,
            reason: null,
            currentStatus: "pending",
            projectedHours: 6,
            cap: 10,
            explanation: "Ranked #1 of 3 eligible applicants",
            tutor: { name: "Alice" },
            course: { course_code: "COMS1000" },
          },
          {
            id: 101,
            tutor_id: "t2",
            course_id: 11,
            willApply: false,
            reason: "no longer a pending application",
            currentStatus: "approved",
            projectedHours: null,
            cap: null,
            tutor: { name: "Bob" },
            course: { course_code: "COMS1001" },
          },
        ],
      },
    });
    await wait();

    window.document.querySelector("#draftsList article button").click();
    await wait();

    expect(calls.find((c) => c.url.includes("/compare")).url).toBe(
      "/api/allocation-drafts/2/compare",
    );

    const modal = window.document.getElementById("compareModal");
    expect(modal.open).toBe(true);

    const list = window.document.getElementById("compareList");
    expect(list.textContent).toContain("Alice — COMS1000");
    expect(list.textContent).toContain("Ranked #1 of 3");
    expect(list.textContent).toContain("would take them to 6/10 hrs/week");
    expect(list.textContent).toContain("Bob — COMS1001");
    expect(list.textContent).toContain(
      "no longer a pending application (now approved)",
    );

    // Only the still-landable proposal gets a checkbox; the stale one can't
    // be picked, so it can't be excluded either.
    expect(list.querySelectorAll(".compare-check")).toHaveLength(1);

    expect(window.document.getElementById("compareHint").textContent).toContain(
      "1 of 2 assignments would still land today",
    );
    expect(window.document.getElementById("comparePublishBtn").disabled).toBe(
      false,
    );
  });

  test("hides the publish button when nothing would still apply", async () => {
    const { window } = loadPage({
      drafts: [
        {
          id: 2,
          name: "Run two",
          status: "draft",
          assignmentCount: 1,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      compare: {
        draft: { id: 2, status: "draft" },
        summary: { willApply: 0, cannotApply: 1 },
        assignments: [
          {
            id: 100,
            tutor_id: "t1",
            course_id: 10,
            willApply: false,
            reason: "course is now full",
            currentStatus: "pending",
            tutor: { name: "Alice" },
            course: { course_code: "COMS1000" },
          },
        ],
      },
    });
    await wait();

    window.document.querySelector("#draftsList article button").click();
    await wait();

    expect(window.document.getElementById("comparePublishBtn").hidden).toBe(
      true,
    );
    expect(window.document.getElementById("compareHint").textContent).toContain(
      "None of these would still land today",
    );
  });

  test("publishing applies only the still-checked rows and refreshes both lists", async () => {
    const { window, calls } = loadPage({
      drafts: [
        {
          id: 2,
          name: "Run two",
          status: "draft",
          assignmentCount: 3,
          created_at: "2026-01-02T00:00:00Z",
        },
      ],
      compare: {
        draft: { id: 2, status: "draft" },
        summary: { willApply: 2, cannotApply: 1 },
        assignments: [
          {
            id: 100,
            tutor_id: "t1",
            course_id: 10,
            willApply: true,
            reason: null,
            currentStatus: "pending",
            explanation: "x",
            tutor: { name: "Alice" },
            course: { course_code: "COMS1000" },
          },
          {
            id: 101,
            tutor_id: "t2",
            course_id: 11,
            willApply: true,
            reason: null,
            currentStatus: "pending",
            explanation: "y",
            tutor: { name: "Bob" },
            course: { course_code: "COMS1001" },
          },
          {
            id: 102,
            tutor_id: "t3",
            course_id: 12,
            willApply: false,
            reason: "course is now full",
            currentStatus: "pending",
            tutor: { name: "Carol" },
            course: { course_code: "COMS1002" },
          },
        ],
      },
      publishResult: {
        draft: { id: 2, status: "published" },
        results: [
          { assignmentId: 100, success: false, reason: "excluded" },
          { assignmentId: 101, success: true },
          { assignmentId: 102, success: true },
        ],
      },
    });
    await wait();

    window.document.querySelector("#draftsList article button").click();
    await wait();

    // Drop Alice from the publish, keep Bob.
    window.document.querySelector(".compare-check[data-id='100']").click();
    window.document.getElementById("comparePublishBtn").click();
    await wait();

    const publishCall = calls.find((c) => c.url.includes("/publish"));
    expect(publishCall.url).toBe("/api/allocation-drafts/2/publish");
    expect(publishCall.opts.method).toBe("POST");
    expect(JSON.parse(publishCall.opts.body)).toEqual({
      organiserId: "organiser-1",
      excludeAssignmentIds: ["100"],
    });

    expect(window.document.getElementById("compareModal").open).toBe(false);
    expect(window.document.getElementById("toast").textContent).toContain(
      "2 published",
    );

    // Both lists refreshed after publishing.
    const draftFetches = calls.filter(
      (c) => c.url === "/api/allocation-drafts",
    );
    expect(draftFetches.length).toBeGreaterThanOrEqual(2);
  });
});
