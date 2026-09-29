// organiser-requests.js is a plain browser script driving two review queues
// (sign-ups + additional access) on the same page — same jsdom approach as
// board.keyboard-nav.test.js: load the real HTML and the real script into a
// jsdom window with a stubbed fetch, and assert on the DOM it builds.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const pageHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "organiser-requests.html"),
  "utf8",
);
const pageJs = fs.readFileSync(
  path.join(__dirname, "organiser-requests.js"),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ROWS = [
  {
    id: 1,
    user_id: "u1",
    course_id: 7,
    status: "pending",
    kind: "signup",
    created_at: "2026-09-10T09:00:00.000Z",
    user: { name: "Nadia New", email: "nadia@wits.ac.za" },
    course: { course_code: "COS132", course_name: "Imperative Programming" },
  },
  {
    id: 2,
    user_id: "u2",
    course_id: 8,
    status: "pending",
    kind: "access",
    created_at: "2026-09-12T09:00:00.000Z",
    user: { name: "Olive Organiser", email: "olive@wits.ac.za" },
    course: { course_code: "COS2011", course_name: "Data Structures" },
  },
];

function loadPage(respond) {
  // Inline the script under test (with its real sourceURL so coverage
  // attribution matches the other jsdom suites); the page's other scripts
  // (user badge, notifications, logout, the storage module guard) aren't
  // what this suite exercises, so they're dropped like the board suite does.
  const html = pageHtml
    .replace(
      '<script src="../js/organiser-requests.js"></script>',
      `<script>${pageJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "organiser-requests.js")).href}</script>`,
    )
    .replace('<script src="../js/user-badge.js"></script>', "")
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "")
    .replace(/<script type="module">[\s\S]*?<\/script>/, "");

  const calls = [];
  const dom = new JSDOM(html, {
    url: "http://localhost/organiser-requests.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "admin1", role: "super_organiser" }),
      );
      window.fetch = (url, opts) => {
        calls.push({ url: String(url), opts });
        return respond(String(url), opts);
      };
    },
  });

  return { window: dom.window, calls };
}

describe("organiser-requests page", () => {
  test("splits sign-ups and additional access into their own sections", async () => {
    const { window } = loadPage(() =>
      Promise.resolve({ ok: true, json: async () => ROWS }),
    );
    await flush();

    const signups = window.document.querySelectorAll(
      "#requestList .review-row",
    );
    const access = window.document.querySelectorAll(
      "#accessRequestList .review-row",
    );

    expect(signups).toHaveLength(1);
    expect(access).toHaveLength(1);
    expect(signups[0].textContent).toContain("Nadia New");
    expect(access[0].textContent).toContain("Olive Organiser");
    expect(access[0].textContent).toContain("COS2011");

    // Chip counts are per-queue, not page-wide.
    const signupChip = window.document.querySelector(
      '#statusChips [data-status="pending"]',
    );
    const accessChip = window.document.querySelector(
      '#accessStatusChips [data-status="pending"]',
    );
    expect(signupChip.textContent).toContain("(1)");
    expect(accessChip.textContent).toContain("(1)");

    // Rows predating the kind column count as sign-ups.
    const legacy = loadPage(() =>
      Promise.resolve({
        ok: true,
        json: async () => [{ ...ROWS[0], id: 3, kind: undefined }],
      }),
    );
    await flush();
    expect(
      legacy.window.document.querySelectorAll("#requestList .review-row"),
    ).toHaveLength(1);
    expect(
      legacy.window.document.querySelectorAll("#accessRequestList .review-row"),
    ).toHaveLength(0);

    window.close();
    legacy.window.close();
  });

  test("each queue filters independently", async () => {
    const { window } = loadPage(() =>
      Promise.resolve({
        ok: true,
        json: async () => [
          ...ROWS,
          {
            id: 3,
            user_id: "u3",
            course_id: 9,
            status: "approved",
            kind: "access",
            created_at: "2026-09-13T09:00:00.000Z",
            user: { name: "Andy Approved", email: "andy@wits.ac.za" },
            course: { course_code: "COS3001", course_name: "Algorithms" },
          },
        ],
      }),
    );
    await flush();

    // Default filter is pending: each queue shows its one pending row.
    expect(
      window.document.querySelectorAll("#accessRequestList .review-row"),
    ).toHaveLength(1);

    // Flip the additional-access queue to "approved" — the sign-up queue
    // stays on pending.
    window.document
      .querySelector('#accessStatusChips [data-status="approved"]')
      .click();
    await flush();

    const accessRows = window.document.querySelectorAll(
      "#accessRequestList .review-row",
    );
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0].textContent).toContain("Andy Approved");
    expect(
      window.document.querySelectorAll("#requestList .review-row"),
    ).toHaveLength(1);
    expect(
      window.document.querySelectorAll("#requestList .review-row")[0]
        .textContent,
    ).toContain("Nadia New");

    window.close();
  });

  test("approving an additional-access request posts to the review endpoint", async () => {
    const { window, calls } = loadPage((url, opts) => {
      if (opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 2, status: "approved" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ROWS });
    });
    await flush();

    window.document
      .querySelector("#accessRequestList .applicant-actions .approve")
      .click();
    await flush();

    const post = calls.find((call) => call.opts?.method === "POST");
    expect(post.url).toBe("/api/organiser-requests/2/approve");
    expect(window.document.getElementById("toast").textContent).toMatch(
      /next sign-in/,
    );

    window.close();
  });
});
