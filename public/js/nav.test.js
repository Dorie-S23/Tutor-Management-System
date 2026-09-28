// nav.js is a real ES module ("type": "commonjs" in package.json, no babel
// transform configured), so a plain require() can't parse its `export`
// syntax. Same pattern as the rest of this suite's frontend tests: read it
// as text, drop the `export` keyword, and run it as a classic script inside
// a real jsdom document via runScripts: "dangerously".
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const navSrc = fs
  .readFileSync(path.join(__dirname, "nav.js"), "utf8")
  .replace(/^export /gm, "");

function withDom(bodyHtml, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}<script>${navSrc}\nwindow.__nav = { highlightActiveTab, renderWelcomeHeading };\n//# sourceURL=${pathToFileURL(path.join(__dirname, "nav.js")).href}</script></body>`,
    { url: "http://localhost/html/calendar.html", runScripts: "dangerously" },
  );
  fn(dom.window);
}

describe("renderWelcomeHeading", () => {
  test("sets the welcome heading to the signed-in user's name", () => {
    withDom(`<h1 id="welcome-heading">Welcome!</h1>`, (window) => {
      window.__nav.renderWelcomeHeading("Mutsawashe Njowa");
      expect(
        window.document.getElementById("welcome-heading").textContent,
      ).toBe("Welcome, Mutsawashe Njowa!");
    });
  });

  test("does nothing if the page has no welcome-heading element", () => {
    withDom(`<h1>Log Hours</h1>`, (window) => {
      expect(() => window.__nav.renderWelcomeHeading("Someone")).not.toThrow();
    });
  });

  test("leaves the placeholder text alone if no name is given", () => {
    withDom(`<h1 id="welcome-heading">Welcome!</h1>`, (window) => {
      window.__nav.renderWelcomeHeading(undefined);
      expect(
        window.document.getElementById("welcome-heading").textContent,
      ).toBe("Welcome!");
    });
  });
});

describe("highlightActiveTab", () => {
  test("marks the .tab-nav link matching the current page as active", () => {
    withDom(
      `
      <nav class="tab-nav">
        <a href="log-hours.html">Log Hours</a>
        <a href="calendar.html">Calendar</a>
      </nav>
    `,
      (window) => {
        const links = window.document.querySelectorAll(".tab-nav a");
        window.__nav.highlightActiveTab();
        expect(links[0].classList.contains("active")).toBe(false);
        expect(links[1].classList.contains("active")).toBe(true);
      },
    );
  });

  test("does nothing when the page has no .tab-nav (the new board-header pages)", () => {
    withDom(
      `<header class="board-header board-header--brand"></header>`,
      (window) => {
        expect(() => window.__nav.highlightActiveTab()).not.toThrow();
      },
    );
  });
});
