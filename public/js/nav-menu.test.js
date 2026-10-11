// nav-menu.js collapses the header's nav links into a hamburger dropdown on
// phone-sized screens, for both header shells in the app: .tab-nav on
// tutor/organiser pages (nothing but links) and .header-actions on volunteer
// pages (links interleaved with the notification bell). Loaded into real
// jsdom documents from <head>, exactly where the pages load it, so the
// script takes its production DOMContentLoaded path. matchMedia is stubbed
// per query string so each test can start above or below the breakpoint and
// cross it in either direction.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const navMenuJs = fs.readFileSync(path.join(__dirname, "nav-menu.js"), "utf8");
const navMenuUrl = pathToFileURL(path.join(__dirname, "nav-menu.js")).href;

const TAB_NAV_QUERY = "(max-width: 720px)";
const HEADER_ACTIONS_QUERY = "(max-width: 860px)";

// app.css shell: .tab-nav holds nothing but nav links.
const APP_SHELL = `
  <nav class="tab-nav">
    <a href="dashboard.html">Dashboard</a>
    <a href="modules.html">Modules</a>
  </nav>
`;

// global.css shell: nav links and the notification bell sit side by side in
// .header-actions.
const VOLUNTEER_SHELL = `
  <div class="header-actions">
    <a href="StudentView.html">Home</a>
    <button type="button" class="notif-bell-btn">bell</button>
    <a href="#" class="btn-logout">Log out</a>
  </div>
`;

function loadPage(bodyHtml, initialMatches = {}) {
  // One matchMedia stub per query string, each remembering its change
  // listeners so a test can cross the breakpoint and fire the change.
  const queries = new Map();
  function matchMedia(query) {
    if (!queries.has(query)) {
      const listeners = new Set();
      const mql = {
        matches: initialMatches[query] === true,
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
      };
      queries.set(query, {
        mql,
        cross(matches) {
          mql.matches = matches;
          listeners.forEach((fn) => fn());
        },
      });
    }
    return queries.get(query).mql;
  }

  const dom = new JSDOM(
    `<!doctype html><html><head><script>${navMenuJs}\n//# sourceURL=${navMenuUrl}</script></head><body>${bodyHtml}</body></html>`,
    {
      url: "http://localhost/tutors.html",
      runScripts: "dangerously",
      beforeParse(window) {
        window.matchMedia = matchMedia;
      },
    },
  );

  return { window: dom.window, document: dom.window.document, queries };
}

// jsdom fires DOMContentLoaded a tick after the constructor returns, so the
// head-loaded script's mount hasn't happened yet at that point.
const ready = () => new Promise((resolve) => setTimeout(resolve, 0));

const click = (el, window) =>
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

describe("nav-menu.js", () => {
  describe("app shell (.tab-nav)", () => {
    test("mounts a closed hamburger when loaded at phone width", async () => {
      const { document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();

      const wrap = document.querySelector(".nav-menu");
      expect(wrap).not.toBeNull();

      const toggle = wrap.querySelector(".nav-menu-toggle");
      expect(toggle.getAttribute("aria-label")).toBe("Menu");
      expect(toggle.getAttribute("aria-haspopup")).toBe("true");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      // The nav itself became the panel: tucked inside the wrap after the
      // toggle, panel-classed and closed.
      const tabNav = document.querySelector(".tab-nav");
      expect(wrap.firstElementChild).toBe(toggle);
      expect(wrap.lastElementChild).toBe(tabNav);
      expect(tabNav.classList.contains("nav-menu-panel")).toBe(true);
      expect(tabNav.hidden).toBe(true);
      expect(tabNav.querySelectorAll("a")).toHaveLength(2);
    });

    test("the toggle opens and closes the menu, flipping aria-expanded", async () => {
      const { window, document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      const toggle = document.querySelector(".nav-menu-toggle");
      const panel = document.querySelector(".tab-nav");

      click(toggle, window);
      expect(panel.hidden).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.classList.contains("is-open")).toBe(true);

      click(toggle, window);
      expect(panel.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.classList.contains("is-open")).toBe(false);
    });

    test("Escape closes the open menu and puts focus back on the toggle", async () => {
      const { window, document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      const toggle = document.querySelector(".nav-menu-toggle");
      const panel = document.querySelector(".tab-nav");

      click(toggle, window);
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape" }),
      );

      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(toggle);
    });

    test("a click outside closes the menu; a click inside keeps it open", async () => {
      const { window, document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      const toggle = document.querySelector(".nav-menu-toggle");
      const panel = document.querySelector(".tab-nav");

      click(toggle, window);
      click(document.body, window);
      expect(panel.hidden).toBe(true);

      click(toggle, window);
      click(panel, window);
      expect(panel.hidden).toBe(false);
    });

    test("choosing a link closes the menu", async () => {
      const { window, document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      const toggle = document.querySelector(".nav-menu-toggle");
      const panel = document.querySelector(".tab-nav");
      const link = panel.querySelector("a");

      click(toggle, window);
      click(link, window);
      expect(panel.hidden).toBe(true);
    });

    test("growing past the breakpoint unmounts and restores the plain header", async () => {
      const { document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      queries.get(TAB_NAV_QUERY).cross(false);

      expect(document.querySelector(".nav-menu")).toBeNull();
      const tabNav = document.querySelector(".tab-nav");
      expect(tabNav.classList.contains("nav-menu-panel")).toBe(false);
      expect(tabNav.hidden).toBe(false);
      // Both links are back where they started.
      expect(tabNav.querySelectorAll("a")).toHaveLength(2);
    });

    test("shrinking again remounts a fresh, closed menu", async () => {
      const { document, queries } = loadPage(APP_SHELL, {
        [TAB_NAV_QUERY]: true,
      });
      await ready();
      queries.get(TAB_NAV_QUERY).cross(false);
      queries.get(TAB_NAV_QUERY).cross(true);

      const wrap = document.querySelector(".nav-menu");
      expect(wrap).not.toBeNull();
      expect(
        wrap.querySelector(".nav-menu-toggle").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(document.querySelector(".tab-nav").hidden).toBe(true);
    });
  });

  describe("volunteer shell (.header-actions)", () => {
    test("moves only the links into the panel, leaving the bell alone", async () => {
      const { document, queries } = loadPage(VOLUNTEER_SHELL, {
        [HEADER_ACTIONS_QUERY]: true,
      });
      await ready();

      const headerActions = document.querySelector(".header-actions");
      const wrap = headerActions.querySelector(":scope > .nav-menu");
      expect(wrap).not.toBeNull();
      // The menu is the first thing in the header actions.
      expect(headerActions.firstElementChild).toBe(wrap);

      const toggle = wrap.querySelector(".nav-menu-toggle");
      const panel = wrap.querySelector(".nav-menu-panel");
      expect(toggle.classList.contains("notif-bell-btn")).toBe(true);
      // Both links live in the panel...
      expect(panel.querySelectorAll("a")).toHaveLength(2);
      // ...and the bell stayed behind as a direct child, outside the panel.
      const bell = headerActions.querySelector(".notif-bell-btn");
      expect(bell).not.toBeNull();
      expect(panel.contains(bell)).toBe(false);
    });

    test("unmounting restores the original interleaved order", async () => {
      const { document, queries } = loadPage(VOLUNTEER_SHELL, {
        [HEADER_ACTIONS_QUERY]: true,
      });
      await ready();
      queries.get(HEADER_ACTIONS_QUERY).cross(false);

      const headerActions = document.querySelector(".header-actions");
      expect(headerActions.querySelector(".nav-menu")).toBeNull();
      expect(
        [...headerActions.children].map((el) => el.textContent.trim()),
      ).toEqual(["Home", "bell", "Log out"]);
    });
  });

  test("a page without nav landmarks stays untouched", async () => {
    const { document } = loadPage("<main><p>content</p></main>");
    await ready();

    expect(document.querySelector(".nav-menu")).toBeNull();
    expect(document.querySelector(".nav-menu-toggle")).toBeNull();
  });

  test("a .tab-nav without links falls through to .header-actions", async () => {
    const { document, queries } = loadPage(
      `<nav class="tab-nav"></nav>${VOLUNTEER_SHELL}`,
      { [HEADER_ACTIONS_QUERY]: true },
    );
    await ready();

    // The empty .tab-nav was left as-is; the menu mounted against the
    // header actions (and only at the 860px breakpoint, not 720px).
    expect(document.querySelector(".tab-nav").hidden).toBe(false);
    expect(
      document
        .querySelector(".header-actions")
        .querySelector(":scope > .nav-menu"),
    ).not.toBeNull();
  });
});
