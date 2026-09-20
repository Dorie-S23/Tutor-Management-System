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

function loadPage({ drafts = [], auditLog = [], confirmReturns = true } = {}) {
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

  test("renders past drafts with a Restore button only on published ones", async () => {
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
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll("#draftsList article");
    expect(cards).toHaveLength(2);

    const published = Array.from(cards).find((c) =>
      c.textContent.includes("Run one"),
    );
    const draft = Array.from(cards).find((c) =>
      c.textContent.includes("Run two"),
    );

    expect(published.querySelector("button")?.textContent).toBe("Restore");
    expect(draft.querySelector("button")).toBeNull();
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
});
