// Five small page-scoped helper scripts, loaded into real jsdom documents
// the same way the other frontend suites do it (inline injection plus the
// //# sourceURL tag so Jest's v8 coverage attributes executed lines back to
// the real files):
//
//   theme.js           - the site-wide light/dark toggle
//   auth-ui.js         - the login/register password reveal buttons
//   logout.js          - the header's log-out button
//   sessions.js        - read-only view onto the stored session list
//   highlightTarget.js - ?highlightCourse= scroll/flash helpers
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
const sourceUrl = (file) =>
  `//# sourceURL=${pathToFileURL(path.join(__dirname, file)).href}`;

const themeJs = read("theme.js");
const authUiJs = read("auth-ui.js");
const logoutJs = read("logout.js");
const sessionsJs = read("sessions.js").replace(/^export /gm, "");
const highlightTargetJs = read("highlightTarget.js").replace(/^export /gm, "");

const ready = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- theme.js --------------------------------------------------------------

describe("theme.js", () => {
  function loadTheme({
    body = '<div class="header-actions"></div>',
    stored,
    matchMediaDark,
    breakStorage,
  } = {}) {
    const dom = new JSDOM(
      `<!doctype html><html><head><script>${themeJs}\n${sourceUrl("theme.js")}</script></head><body>${body}</body></html>`,
      {
        url: "http://localhost/dashboard.html",
        runScripts: "dangerously",
        beforeParse(window) {
          if (breakStorage) {
            // Stand in for a browser where touching storage itself throws.
            Object.defineProperty(window, "localStorage", {
              configurable: true,
              value: {
                getItem() {
                  throw new Error("storage disabled");
                },
                setItem() {
                  throw new Error("storage disabled");
                },
              },
            });
          } else if (stored !== undefined) {
            window.localStorage.setItem("tms-theme", stored);
          }
          if (matchMediaDark !== undefined) {
            window.matchMedia = () => ({ matches: matchMediaDark });
          }
        },
      },
    );
    return dom.window;
  }

  test("restores the stored dark theme and mounts a working toggle", async () => {
    const win = loadTheme({ stored: "dark" });
    await ready();

    const button = win.document.querySelector(".theme-toggle");
    expect(button).toBeTruthy();
    expect(win.document.documentElement.dataset.theme).toBe("dark");
    expect(button.textContent).toBe("Light mode");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Switch to light mode");

    button.click();
    expect(win.document.documentElement.dataset.theme).toBe("light");
    expect(win.localStorage.getItem("tms-theme")).toBe("light");
    expect(button.textContent).toBe("Dark mode");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Switch to dark mode");
  });

  test("restores a stored light theme", async () => {
    const win = loadTheme({ stored: "light" });
    await ready();
    expect(win.document.documentElement.dataset.theme).toBe("light");
    expect(win.document.querySelector(".theme-toggle").textContent).toBe(
      "Dark mode",
    );
  });

  test("falls back to a dark system preference when nothing valid is stored", async () => {
    const win = loadTheme({ stored: "plaid", matchMediaDark: true });
    await ready();
    expect(win.document.documentElement.dataset.theme).toBe("dark");
  });

  test("falls back to light when the system preference is not dark", async () => {
    const win = loadTheme({ stored: "plaid", matchMediaDark: false });
    await ready();
    expect(win.document.documentElement.dataset.theme).toBe("light");
  });

  test("falls back cleanly when browser storage is unavailable", async () => {
    const win = loadTheme({ breakStorage: true, matchMediaDark: false });
    await ready();

    expect(win.document.documentElement.dataset.theme).toBe("light");

    // Toggling must still work — only the persist step is expected to fail.
    const button = win.document.querySelector(".theme-toggle");
    button.click();
    expect(win.document.documentElement.dataset.theme).toBe("dark");
  });

  test("prefers the redesigned navbar's slot over the legacy tab nav", async () => {
    const win = loadTheme({
      body: '<nav class="tab-nav"><a href="#">Home</a></nav><div class="navbar-right"></div>',
    });
    await ready();

    const toggle = win.document.querySelector(".theme-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle.parentElement.className).toBe("navbar-right");
    expect(win.document.querySelector(".tab-nav .theme-toggle")).toBeNull();
  });

  test("mounts into the auth shell on the login and register pages", async () => {
    const win = loadTheme({
      body: '<main class="auth-shell"><form></form></main>',
    });
    await ready();

    const toggle = win.document.querySelector(".theme-toggle");
    expect(toggle).toBeTruthy();
    expect(toggle.parentElement.className).toBe("auth-shell");
  });

  test("does not mount a toggle on a page without a host element", async () => {
    const win = loadTheme({ body: "<p>bare page</p>" });
    await ready();

    expect(win.document.querySelector(".theme-toggle")).toBeNull();
    expect(win.document.documentElement.dataset.theme).toBeTruthy();
  });

  test("prefers the navbar action cluster over the tab bar", async () => {
    const win = loadTheme({
      body: '<nav class="tab-nav"><a href="dashboard.html">Dashboard</a></nav><div class="navbar-right"><button type="button">Log out</button></div>',
    });
    await ready();

    const button = win.document.querySelector(".theme-toggle");
    expect(button).toBeTruthy();
    expect(button.parentElement.classList.contains("navbar-right")).toBe(true);
    expect(win.document.querySelectorAll(".theme-toggle").length).toBe(1);
  });

  test("mounts on the split-screen auth pages through .auth-shell", async () => {
    const win = loadTheme({
      body: '<div class="auth-shell"><aside class="auth-brand"></aside><div class="auth-panel"></div></div>',
    });
    await ready();

    const button = win.document.querySelector(".theme-toggle");
    expect(button).toBeTruthy();
    expect(button.parentElement.classList.contains("auth-shell")).toBe(true);
  });

  test("still falls back to a bare tab bar", async () => {
    const win = loadTheme({
      body: '<nav class="tab-nav"><a href="dashboard.html">Dashboard</a></nav>',
    });
    await ready();

    const button = win.document.querySelector(".theme-toggle");
    expect(button).toBeTruthy();
    expect(button.parentElement.classList.contains("tab-nav")).toBe(true);
  });
});

// --- auth-ui.js ------------------------------------------------------------

describe("auth-ui.js", () => {
  function loadAuthUi() {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <input id="password" type="password">
        <button class="password-toggle" data-target="password"></button>
        <button class="password-toggle" data-target="missing-field"></button>
        <script>${authUiJs}\n${sourceUrl("auth-ui.js")}</script>
      </body></html>`,
      { url: "http://localhost/login.html", runScripts: "dangerously" },
    );
    return dom.window;
  }

  test("toggles the target field between password and text", () => {
    const win = loadAuthUi();
    const input = win.document.getElementById("password");
    const button = win.document.querySelector('[data-target="password"]');

    button.click();
    expect(input.type).toBe("text");
    expect(button.classList.contains("is-revealed")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Hide password");

    button.click();
    expect(input.type).toBe("password");
    expect(button.classList.contains("is-revealed")).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Show password");
  });

  test("ignores a toggle whose data-target matches no field", () => {
    const win = loadAuthUi();
    const button = win.document.querySelector('[data-target="missing-field"]');
    expect(() => button.click()).not.toThrow();
  });
});

// --- logout.js -------------------------------------------------------------

describe("logout.js", () => {
  test("clicking the header button clears the session", () => {
    // The click handler ends with `window.location.href = "login.html"`,
    // which jsdom reports as "Not implemented: navigation" — swallow that
    // through a quiet virtual console so the suite output stays clean.
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", () => {});

    const dom = new JSDOM(
      `<!doctype html><html><body><button id="logout-button">Log out</button><script>${logoutJs}\n${sourceUrl("logout.js")}</script></body></html>`,
      {
        url: "http://localhost/dashboard.html",
        runScripts: "dangerously",
        virtualConsole,
        beforeParse(window) {
          window.sessionStorage.setItem("access_token", "token");
          window.sessionStorage.setItem("user", "{}");
        },
      },
    );

    dom.window.document.getElementById("logout-button").click();

    expect(dom.window.sessionStorage.getItem("access_token")).toBeNull();
    expect(dom.window.sessionStorage.getItem("user")).toBeNull();
  });
});

// --- sessions.js -----------------------------------------------------------

describe("sessions.js", () => {
  function loadSessions() {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "http://localhost/dashboard.html",
      runScripts: "dangerously",
    });
    dom.window.eval(
      `${sessionsJs}\nwindow.__sessions = { getSessions, getSessionsForDate };\n${sourceUrl("sessions.js")}`,
    );
    return dom.window;
  }

  test("returns an empty list when nothing is stored", () => {
    const win = loadSessions();
    expect(win.__sessions.getSessions()).toEqual([]);
  });

  test("reads the stored session list and filters it by date", () => {
    const win = loadSessions();
    win.localStorage.setItem(
      "tutorHours.sessions",
      JSON.stringify([
        { id: 1, date: "2026-09-01" },
        { id: 2, date: "2026-09-02" },
      ]),
    );

    expect(win.__sessions.getSessions()).toHaveLength(2);
    expect(win.__sessions.getSessionsForDate("2026-09-02")).toEqual([
      { id: 2, date: "2026-09-02" },
    ]);
  });

  test("ignores corrupted or non-list stored values", () => {
    const win = loadSessions();
    win.localStorage.setItem("tutorHours.sessions", "{not json");
    expect(win.__sessions.getSessions()).toEqual([]);

    win.localStorage.setItem("tutorHours.sessions", JSON.stringify({ a: 1 }));
    expect(win.__sessions.getSessions()).toEqual([]);
  });
});

// --- highlightTarget.js ----------------------------------------------------

describe("highlightTarget.js", () => {
  function loadHighlight(url) {
    const dom = new JSDOM(
      '<!doctype html><html><body><div id="row" class="course-row"></div></body></html>',
      { url, runScripts: "dangerously" },
    );
    dom.window.eval(
      `${highlightTargetJs}\nwindow.__highlight = { consumeQueryParam, scrollAndHighlight };\n${sourceUrl("highlightTarget.js")}`,
    );
    return dom.window;
  }

  test("consumes the param once and strips it from the URL", () => {
    const win = loadHighlight(
      "http://localhost/dashboard.html?highlightCourse=c1&keep=1",
    );
    const consume = win.__highlight.consumeQueryParam;

    expect(consume("highlightCourse")).toBe("c1");
    expect(win.location.search).toBe("?keep=1");
    expect(consume("highlightCourse")).toBeNull();

    expect(consume("nope")).toBeNull();
    expect(win.location.search).toBe("?keep=1");
  });

  test("removes the query string entirely when it held nothing else", () => {
    const win = loadHighlight(
      "http://localhost/dashboard.html?highlightCourse=c1",
    );
    expect(win.__highlight.consumeQueryParam("highlightCourse")).toBe("c1");
    expect(win.location.search).toBe("");
  });

  test("scrolls the row into view and flashes it briefly", () => {
    const win = loadHighlight("http://localhost/dashboard.html");
    const el = win.document.getElementById("row");

    const scrollCalls = [];
    win.HTMLElement.prototype.scrollIntoView = function (options) {
      scrollCalls.push(options);
    };
    let scheduled = null;
    win.setTimeout = (fn) => {
      scheduled = fn;
      return 1;
    };

    win.__highlight.scrollAndHighlight(el);
    expect(scrollCalls).toEqual([{ behavior: "smooth", block: "center" }]);
    expect(el.classList.contains("highlight-flash")).toBe(true);

    scheduled();
    expect(el.classList.contains("highlight-flash")).toBe(false);
  });

  test("does nothing when there is no row to highlight", () => {
    const win = loadHighlight("http://localhost/dashboard.html");
    expect(() => win.__highlight.scrollAndHighlight(null)).not.toThrow();
  });
});
