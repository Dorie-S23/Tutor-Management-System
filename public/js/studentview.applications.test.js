// studentview.js is a real ES module (imports from ./storage.js), so — same
// problem as board.js's keyboard-nav test, plus jsdom doesn't reliably run
// <script type="module"> at all even with runScripts: "dangerously" — we
// load it as a classic script with storage.js's two imports (getEntries,
// requireRole) stubbed out, sharing scope with test hooks the same way the
// board.js test does. window.fetch has to be stubbed inside beforeParse,
// not after `new JSDOM(...)` returns — the inline script runs synchronously
// during parsing, so anything set afterward is too late for the page's own
// init IIFE.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const html = fs.readFileSync(
  path.join(__dirname, "..", "html", "StudentView.html"),
  "utf8",
);
const studentviewSrc = fs
  .readFileSync(path.join(__dirname, "studentview.js"), "utf8")
  .replace(/^import \{ getEntries, requireRole \} from ".\/storage.js";$/m, "");

const stubs = `
function requireRole() {
  return { id: "student-1", name: "Test Student", role: "student" };
}
async function getEntries() { return []; }
`;

function loadPage({ courses = [], applications = [] } = {}) {
  const script = `<script>${stubs}\n${studentviewSrc}\n</script>`;
  const pageHtml = html
    .replace(
      '<script type="module" src="../js/studentview.js"></script>',
      script,
    )
    .replace('<script src="../js/onboarding.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url: "http://localhost/StudentView.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = {};
      if (!window.CSS.escape) {
        window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
      }

      window.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        const u = String(url);
        if (u.includes("/api/courses")) {
          return { ok: true, json: async () => courses };
        }
        if (u.includes("/api/course-volunteers") && opts?.method === "DELETE") {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        if (u.includes("/api/course-volunteers")) {
          return { ok: true, json: async () => applications };
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

describe("studentview.js — My Applications", () => {
  test("shows pending, approved and rejected applications together, not just pending", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
        {
          id: "a2",
          course_id: 2,
          mark: 70,
          status: "approved",
          courses: { course_code: "COMS2000", course_name: "Data Structures" },
        },
        {
          id: "a3",
          course_id: 3,
          mark: 40,
          status: "rejected",
          reason: "Mark below the course minimum",
          courses: { course_code: "COMS3000", course_name: "Advanced Topics" },
        },
      ],
    });
    await wait();

    const cards = window.document.querySelectorAll("#pendingList article");
    expect(cards.length).toBe(3);

    const text = window.document.getElementById("pendingList").textContent;
    expect(text).toContain("COMS1000");
    expect(text).toContain("COMS2000");
    expect(text).toContain("COMS3000");
  });

  test("shows the rejection reason on a rejected application", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a3",
          course_id: 3,
          mark: 40,
          status: "rejected",
          reason: "Mark below the course minimum",
          courses: { course_code: "COMS3000", course_name: "Advanced Topics" },
        },
      ],
    });
    await wait();

    expect(window.document.getElementById("pendingList").textContent).toContain(
      "Mark below the course minimum",
    );
  });

  test("only a pending application gets a Withdraw button", async () => {
    const { window } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
        {
          id: "a2",
          course_id: 2,
          mark: 70,
          status: "approved",
          courses: { course_code: "COMS2000", course_name: "Data Structures" },
        },
      ],
    });
    await wait();

    const cards = Array.from(
      window.document.querySelectorAll("#pendingList article"),
    );
    const pendingCard = cards.find((c) => c.textContent.includes("COMS1000"));
    const approvedCard = cards.find((c) => c.textContent.includes("COMS2000"));

    expect(pendingCard.querySelector("button")?.textContent).toBe("Withdraw");
    expect(approvedCard.querySelector("button")).toBeNull();
  });

  test("clicking Withdraw calls DELETE with the signed-in student's id and the right course", async () => {
    const { window, calls } = loadPage({
      applications: [
        {
          id: "a1",
          course_id: 1,
          mark: 82,
          status: "pending",
          courses: { course_code: "COMS1000", course_name: "Intro" },
        },
      ],
    });
    await wait();

    const withdrawBtn = window.document.querySelector(
      "#pendingList article button",
    );
    withdrawBtn.click();
    await wait();

    const deleteCall = calls.find((c) => c.opts?.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall.url).toContain("userId=student-1");
    expect(deleteCall.url).toContain("courseId=1");
  });
});
