// The board shows organisers a "Transcript" button on every applicant and
// volunteer row, opening the file through /api/transcripts/.../signed-url.
// Loads the real board.html + board.js into jsdom (same harness as
// board.keyboard-nav.test.js) and drives the button the way a click would.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
const boardJsUrl = pathToFileURL(path.join(__dirname, "board.js")).href;

// Appended to board.js's own script text so it shares board.js's top-level
// scope without board.js having to export anything for tests.
const testHooks = `
window.__test = {
  pushCourse: (c) => COURSES.push(c),
  renderCourseList: () => renderCourseList(),
  selectCourse: (id) => selectCourse(id),
};
`;

// board.js's init() starts a polling interval for live updates — closing
// each window after its test stops those timers.
const openDoms = [];

const APPLICANT = {
  id: 1,
  tutor_id: "tutor-1",
  Tutor_name: "Tia Tutor",
  status: "pending",
  tutor_mark: 75,
  Availability: true,
  tutors: { name: "Tia Tutor", academic_level: "honours" },
};

const VOLUNTEER = {
  id: 2,
  user_id: "student-1",
  status: "pending",
  mark: 75,
  users: { name: "Sam Student", email: "sam@students.wits.ac.za" },
};

function json(body, ok = true) {
  return { ok, json: async () => body };
}

function loadBoard(transcriptResponse) {
  const html = boardHtml
    // board.js starts right after <script> and ends with its sourceURL so
    // coverage attributes to the real file; testHooks follow in their own
    // tag, still sharing the classic scripts' top-level scope.
    .replace(
      '<script src="../js/board.js"></script>',
      `<script>${boardJs}\n//# sourceURL=${boardJsUrl}\n</script>` +
        `<script>${testHooks}</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.transcriptCalls = [];
      window.open = jest.fn();
      window.fetch = (url) => {
        const u = String(url);
        if (u.includes("/assignment-check")) {
          // Failure keeps each row's clash/workload checks null — the
          // renderers are built to fail open on this endpoint.
          return Promise.resolve(json({ error: "stub" }, false));
        }
        if (u.includes("/api/tutor-applications?")) {
          return Promise.resolve(json([APPLICANT]));
        }
        if (u.includes("/api/course-volunteers?")) {
          return Promise.resolve(json([VOLUNTEER]));
        }
        if (u.includes("/api/transcripts/")) {
          window.transcriptCalls.push(u);
          return Promise.resolve(
            transcriptResponse ||
              json({ url: "https://signed.example/t.pdf", expiresIn: 300 }),
          );
        }
        return Promise.resolve(json([]));
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

// Waits for the stubbed-fetch promise chains started by init/selectCourse to
// settle before a test touches the DOM they build.
function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function openCourse(window) {
  window.__test.pushCourse({
    id: "c1",
    code: "COMS1000",
    name: "Intro to Testing",
    minMark: 60,
    tutorsAssigned: 0,
    tutorsNeeded: 2,
  });
  window.__test.renderCourseList();
  window.__test.selectCourse("c1");
  await ready();
  await ready();
}

function findButton(window, listId, label) {
  return [
    ...window.document.querySelectorAll(`#${listId} .applicant-actions button`),
  ].find((btn) => btn.textContent === label);
}

describe("board transcript buttons", () => {
  test("each applicant row gets a Transcript button that opens the signed URL", async () => {
    const window = loadBoard();
    await ready();
    await openCourse(window);

    const button = findButton(window, "applicantList", "Transcript");
    expect(button).toBeTruthy();

    button.click();
    await ready();

    expect(window.transcriptCalls).toEqual([
      "/api/transcripts/tutor-1/signed-url",
    ]);
    expect(window.open).toHaveBeenCalledWith(
      "https://signed.example/t.pdf",
      "_blank",
      "noopener",
    );
  });

  test("each volunteer row gets the same Transcript button", async () => {
    const window = loadBoard();
    await ready();
    await openCourse(window);

    const button = findButton(window, "volunteerList", "Transcript");
    expect(button).toBeTruthy();

    button.click();
    await ready();

    expect(window.transcriptCalls).toEqual([
      "/api/transcripts/student-1/signed-url",
    ]);
  });

  test("an applicant with nothing uploaded gets a toast instead of a blank tab", async () => {
    const notFound = {
      ok: false,
      status: 404,
      json: async () => ({ error: "No transcript on file." }),
    };
    const window = loadBoard(notFound);
    await ready();
    await openCourse(window);

    findButton(window, "applicantList", "Transcript").click();
    await ready();

    expect(window.open).not.toHaveBeenCalled();
    expect(window.document.getElementById("toast").textContent).toBe(
      "Tia Tutor hasn't uploaded a transcript yet.",
    );
  });
});
