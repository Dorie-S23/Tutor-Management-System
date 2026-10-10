// Same real-page harness as board.keyboard-nav.test.js: the actual
// board.html + board.js are loaded into jsdom, and fetch is stubbed to
// serve the allocation-drafts endpoints, so the workspace's compare /
// stage / save / publish flows are driven the way a browser would.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// Every test pays a cold-start cost: the real board.html is parsed and the
// full board.js evaluated inline in jsdom. On the self-hosted CI runner the
// job runs in a container whose workspace is the /mnt/c mount, where the
// default 5s per-test budget is too tight — same fix as
// board.transcript.test.js.
jest.setTimeout(15000);

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
// board.js's preset picker reads window.AllocationObjectives, which the real
// page provides via this script tag — inline it the same way so the tested
// markup matches production.
const allocationObjectivesJs = fs.readFileSync(
  path.join(__dirname, "allocation-objectives.js"),
  "utf8",
);

const openDoms = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let requests; // every fetch the page makes: { url, method, body }

function draftDetail(id) {
  const shared = {
    id: 10,
    tutor_id: "t1",
    course_id: 5,
    explanation: "Only eligible applicant",
    tutor: { name: "Ann" },
    course: { course_code: "COMS1000", course_name: "Intro" },
  };
  const unique =
    id === 1
      ? {
          id: 11,
          tutor_id: "t2",
          course_id: 5,
          explanation: "Ranked #2 of 3",
          tutor: { name: "Ben" },
          course: { course_code: "COMS1000", course_name: "Intro" },
        }
      : {
          id: 12,
          tutor_id: "t3",
          course_id: 5,
          explanation: "Ranked #2 of 3",
          tutor: { name: "Cara" },
          course: { course_code: "COMS1000", course_name: "Intro" },
        };
  return {
    draft: {
      id,
      name: id === 1 ? "Merit-first plan" : "Fair hours plan",
      status: "draft",
    },
    assignments: [shared, unique],
  };
}

function loadBoard() {
  const html = boardHtml
    .replace(
      '<script src="../js/allocation-objectives.js"></script>',
      `<script>\n${allocationObjectivesJs}\n</script>`,
    )
    .replace(
      '<script src="../js/board.js"></script>',
      `<script>\n${boardJs}\n</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      requests = [];
      window.confirm = () => true;
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
      window.fetch = (url, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ url: String(url), method, body });

        const reply = (data) =>
          Promise.resolve({ ok: true, status: 200, json: async () => data });

        if (String(url) === "/api/allocation-drafts?status=draft") {
          return reply([
            {
              id: 1,
              name: "Merit-first plan",
              status: "draft",
              created_at: "2026-01-01T10:00:00Z",
              assignmentCount: 2,
            },
            {
              id: 2,
              name: "Fair hours plan",
              status: "draft",
              created_at: "2026-01-02T10:00:00Z",
              assignmentCount: 2,
            },
          ]);
        }

        const detailMatch = String(url).match(
          /^\/api\/allocation-drafts\/(\d+)$/,
        );
        if (detailMatch && method === "GET") {
          return reply(draftDetail(Number(detailMatch[1])));
        }
        if (detailMatch && method === "PATCH") {
          const detail = draftDetail(Number(detailMatch[1]));
          return reply({ draft: { ...detail.draft, name: body.name } });
        }
        if (detailMatch && method === "DELETE") {
          return reply({});
        }

        const removeMatch = String(url).match(
          /^\/api\/allocation-drafts\/(\d+)\/assignments\/remove$/,
        );
        if (removeMatch) {
          const id = Number(removeMatch[1]);
          const detail = draftDetail(id);
          const remaining = detail.assignments.filter(
            (a) => !body.assignmentIds.map(Number).includes(a.id),
          );
          return reply({ draft: detail.draft, assignments: remaining });
        }

        const publishMatch = String(url).match(
          /^\/api\/allocation-drafts\/(\d+)\/publish$/,
        );
        if (publishMatch) {
          return reply({
            draft: { id: Number(publishMatch[1]) },
            results: [{ success: true }, { success: true }],
          });
        }

        // Everything else (courses, tutors, applications) — same empty
        // stand-in the keyboard-nav harness uses.
        return reply([]);
      };
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }
    },
  });

  openDoms.push(dom);
  return dom.window;
}

afterEach(() => {
  openDoms.splice(0).forEach((dom) => dom.window.close());
});

async function openWorkspace(window) {
  await flush();
  window.document.getElementById("draftsBtn").click();
  await flush();
  await flush();
}

async function tickDraft(window, id) {
  window.document
    .querySelector(`.draft-compare-check[data-id="${id}"]`)
    .click();
  await flush();
  await flush();
}

test("lists open drafts and compares ticked ones side by side", async () => {
  const window = loadBoard();
  await openWorkspace(window);

  const modal = window.document.getElementById("allocationDraftsModal");
  expect(modal.open).toBe(true);
  expect(
    window.document.querySelectorAll("#draftsList .draft-card"),
  ).toHaveLength(2);
  expect(window.document.getElementById("draftsHint").textContent).toContain(
    "2 open drafts",
  );

  await tickDraft(window, 1);
  await tickDraft(window, 2);

  const columns = window.document.querySelectorAll(
    "#draftsColumns .draft-column",
  );
  expect(columns).toHaveLength(2);
  expect(columns[0].querySelector(".draft-column-head h3").textContent).toBe(
    "Merit-first plan",
  );
  expect(columns[1].querySelector(".draft-column-head h3").textContent).toBe(
    "Fair hours plan",
  );

  // Ann is proposed by both drafts — unflagged. Each draft's second pick is
  // unique to it, so it should carry the diff flag and the count badge.
  const firstRow = columns[0].querySelector(".tutor-row");
  expect(firstRow.querySelector(".name").textContent).toBe("Ann");
  expect(firstRow.classList.contains("draft-diff")).toBe(false);

  const flagged = columns[0].querySelectorAll(".tutor-row.draft-diff");
  expect(flagged).toHaveLength(1);
  expect(flagged[0].querySelector(".name").textContent).toBe("Ben");
  expect(flagged[0].querySelector(".draft-diff-badge").textContent).toContain(
    "in 1 of 2",
  );
  expect(
    columns[1].querySelector(".tutor-row.draft-diff .name").textContent,
  ).toBe("Cara");
});

test("unchecking a pick stages its removal and Save picks persists it", async () => {
  const window = loadBoard();
  await openWorkspace(window);
  await tickDraft(window, 1);

  const column = window.document.querySelector(
    '#draftsColumns .draft-column[data-draft-id="1"]',
  );
  const saveBtn = column.querySelector(".draft-save-btn");
  expect(saveBtn.disabled).toBe(true);

  const benCheck = column.querySelector('.draft-pick-check[data-id="11"]');
  benCheck.click();
  await flush();

  expect(
    benCheck.closest(".tutor-row").classList.contains("draft-staged"),
  ).toBe(true);
  expect(saveBtn.disabled).toBe(false);
  expect(saveBtn.textContent).toContain("remove 1");

  saveBtn.click();
  await flush();
  await flush();

  const removeRequest = requests.find((r) =>
    r.url.endsWith("/assignments/remove"),
  );
  expect(removeRequest.url).toBe("/api/allocation-drafts/1/assignments/remove");
  expect(removeRequest.method).toBe("POST");
  expect(removeRequest.body).toEqual({ assignmentIds: ["11"] });

  // The column re-renders from the server's answer: only Ann is left.
  const refreshed = window.document.querySelector(
    '#draftsColumns .draft-column[data-draft-id="1"]',
  );
  expect(refreshed.querySelectorAll(".tutor-row")).toHaveLength(1);
  expect(refreshed.querySelector(".tutor-row .name").textContent).toBe("Ann");
});

test("publishing sends the unanswered picks as exclusions and closes the workspace", async () => {
  const window = loadBoard();
  await openWorkspace(window);
  await tickDraft(window, 1);

  const column = window.document.querySelector(
    '#draftsColumns .draft-column[data-draft-id="1"]',
  );
  column.querySelector(".draft-publish-btn").click();
  await flush();
  await flush();

  const publishRequest = requests.find((r) => r.url.endsWith("/publish"));
  expect(publishRequest.url).toBe("/api/allocation-drafts/1/publish");
  expect(publishRequest.method).toBe("POST");
  // No session in jsdom, so getSessionUserId() falls back to "anon".
  expect(publishRequest.body.organiserId).toBe("anon");
  expect(publishRequest.body.excludeAssignmentIds).toEqual([]);
  expect(window.document.getElementById("allocationDraftsModal").open).toBe(
    false,
  );
});
