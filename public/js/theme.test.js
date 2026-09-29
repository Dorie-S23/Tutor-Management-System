// theme.js is a plain browser IIFE (no imports/exports), so it runs as-is
// inside a real jsdom document via runScripts: "dangerously" — same pattern
// as the rest of this suite's frontend tests.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const src = fs.readFileSync(path.join(__dirname, "theme.js"), "utf8");

function withDom(bodyHtml, { stored, prefersDark } = {}, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}<script>${src}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "theme.js")).href}</script></body>`,
    {
      url: "http://localhost/html/dashboard.html",
      runScripts: "dangerously",
      beforeParse(window) {
        if (stored) window.localStorage.setItem("tms-theme", stored);
        window.matchMedia = (query) => ({
          matches: query.includes("dark") ? Boolean(prefersDark) : false,
        });
      },
    },
  );
  // theme.js defers mountToggle() to DOMContentLoaded (the inline script
  // runs while readyState is still "loading"), and jsdom hasn't fired it
  // yet by the time the constructor returns — nudge it along.
  dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  fn(dom.window);
}

describe("theme", () => {
  test("applies the stored theme on load and mounts a toggle button", () => {
    withDom(
      `<div class="navbar-right"></div>`,
      { stored: "dark" },
      (window) => {
        const root = window.document.documentElement;
        expect(root.dataset.theme).toBe("dark");
        expect(root.style.colorScheme).toBe("dark");

        const button = window.document.querySelector(".theme-toggle");
        expect(button.textContent).toBe("Light mode");
        expect(button.getAttribute("aria-pressed")).toBe("true");
      },
    );
  });

  test("falls back to the system preference when nothing is stored", () => {
    withDom(
      `<div class="navbar-right"></div>`,
      { prefersDark: true },
      (window) => {
        expect(window.document.documentElement.dataset.theme).toBe("dark");
      },
    );
  });

  test("defaults to light when nothing stored and system prefers light", () => {
    withDom(
      `<div class="navbar-right"></div>`,
      { prefersDark: false },
      (window) => {
        expect(window.document.documentElement.dataset.theme).toBe("light");
      },
    );
  });

  test("clicking the toggle flips the theme and persists it", () => {
    withDom(
      `<div class="navbar-right"></div>`,
      { stored: "light" },
      (window) => {
        const root = window.document.documentElement;
        const button = window.document.querySelector(".theme-toggle");

        button.click();
        expect(root.dataset.theme).toBe("dark");
        expect(window.localStorage.getItem("tms-theme")).toBe("dark");
        expect(button.textContent).toBe("Light mode");

        button.click();
        expect(root.dataset.theme).toBe("light");
        expect(window.localStorage.getItem("tms-theme")).toBe("light");
        expect(button.textContent).toBe("Dark mode");
      },
    );
  });

  test("mounts into the first matching slot, preferring .navbar-right", () => {
    withDom(
      `
      <div class="header-actions"></div>
      <div class="navbar-right"></div>
    `,
      { stored: "light" },
      (window) => {
        expect(
          window.document.querySelector(".navbar-right .theme-toggle"),
        ).not.toBeNull();
        expect(
          window.document.querySelector(".header-actions .theme-toggle"),
        ).toBeNull();
      },
    );
  });

  test("mounts no toggle when the page has none of the known slots", () => {
    withDom(`<main>just content</main>`, { stored: "light" }, (window) => {
      expect(window.document.querySelector(".theme-toggle")).toBeNull();
      // The theme itself was still applied.
      expect(window.document.documentElement.dataset.theme).toBe("light");
    });
  });
});
