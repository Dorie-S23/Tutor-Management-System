// The board's "Synced … ago" stamp is an icon that stays transparent-ish
// in the toolbar; the exact wording lives in its title/aria-label (hover
// reveals it, stepping up through seconds → minutes → hours → days), and
// the icon flashes to full opacity for a moment each time a sync lands.
// Same harness as board.drafts.test.js: real board.html + board.js in a
// jsdom document.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

jest.setTimeout(15000);

const boardHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "board.html"),
  "utf8",
);
const boardJs = fs.readFileSync(path.join(__dirname, "board.js"), "utf8");
const allocationObjectivesJs = fs.readFileSync(
  path.join(__dirname, "allocation-objectives.js"),
  "utf8",
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  throw new Error("waitFor timed out");
}

// A controllable clock for board.js's Date.now() calls: real time until a
// test pins a value, so init() stamps lastSyncedAt naturally and the test
// then advances the wall clock to walk the label ladder. Passing null
// un-pins back to real time (needed before a re-sync, which stamps a real
// new Date the pinned clock would otherwise outrun).
function loadBoard() {
  const html = boardHtml
    .replace(
      '<script src="../js/allocation-objectives.js"></script>',
      `<script>\n${allocationObjectivesJs}\n</script>`,
    )
    .replace(
      '<script src="../js/board.js"></script>',
      // Classic scripts share the page's global scope, so the hooks reach
      // board.js's top-level bindings without board.js having to export
      // anything for tests.
      `<script>\n${boardJs}\n</script>\n<script>\nwindow.__syncStatusTest = { tick: () => tickSyncStatusLabel(), resync: () => refreshBoard() };\n</script>`,
    )
    .replace('<script src="../js/logout.js"></script>', "")
    .replace('<script src="../js/onboarding.js"></script>', "");

  const dom = new JSDOM(html, {
    url: "http://localhost/board.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
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
      // Every data fetch resolves to an empty collection — enough for
      // init() and refreshBoard() to complete and stamp the sync status.
      window.fetch = () =>
        Promise.resolve({ ok: true, status: 200, json: async () => [] });
      const realNow = window.Date.now.bind(window.Date);
      let pinned = null;
      window.Date.now = () => (pinned === null ? realNow() : pinned);
      window.__setNow = (value) => {
        pinned = value;
      };
    },
  });
  return dom;
}

describe("board sync-status icon", () => {
  let dom;

  afterEach(() => {
    // init() starts polling intervals — closing the window stops them so
    // they don't fire against a torn-down document and hang the runner.
    dom?.window.close();
    dom = null;
  });

  test("quiet by default; hover label steps up units; flashes on each sync", async () => {
    const t0 = Date.now();
    dom = loadBoard();
    const el = dom.window.document.getElementById("syncStatus");

    // init() stamps lastSyncedAt once its first fetch round completes.
    await waitFor(() => el.title === "Synced just now");

    // Icon, not a text label — the wording lives in title/aria-label.
    expect(el.querySelector("svg")).not.toBeNull();
    expect(el.textContent.trim()).toBe("");
    expect(el.getAttribute("aria-label")).toBe("Synced just now");
    // Transparent-ish by default, and the initial load doesn't flash —
    // the pulse is reserved for re-syncs.
    expect(el.classList.contains("is-flashing")).toBe(false);

    // The hover label steps up through units — no ever-growing counts.
    dom.window.__setNow(t0 + 90_000);
    dom.window.__syncStatusTest.tick();
    expect(el.title).toBe("Synced 1m ago");

    dom.window.__setNow(t0 + 3_700_000);
    dom.window.__syncStatusTest.tick();
    expect(el.title).toBe("Synced 1h ago");

    dom.window.__setNow(t0 + 90_000_000);
    dom.window.__syncStatusTest.tick();
    expect(el.title).toBe("Synced 1d ago");

    // A sync lands: the label resets and the icon flashes to full opacity…
    dom.window.__setNow(null);
    dom.window.__syncStatusTest.resync();
    await waitFor(() => el.title === "Synced just now");
    expect(el.classList.contains("is-flashing")).toBe(true);

    // …then fades back to transparent-ish on its own.
    await waitFor(() => !el.classList.contains("is-flashing"));
    expect(el.classList.contains("is-flashing")).toBe(false);

    await flush();
  });
});
