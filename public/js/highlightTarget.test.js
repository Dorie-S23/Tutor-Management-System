// highlightTarget.js is a real ES module ("type": "commonjs" in
// package.json, no babel transform configured), so a plain require() can't
// parse its `export` syntax. Same pattern as nav.test.js: read it as text,
// drop the `export` keyword, and run it as a classic script in jsdom.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const src = fs
  .readFileSync(path.join(__dirname, "highlightTarget.js"), "utf8")
  .replace(/^export /gm, "");

function withDom(url, fn) {
  const dom = new JSDOM(
    `<body><div id="target"></div><script>${src}\nwindow.__highlightTarget = { consumeQueryParam, scrollAndHighlight };\n//# sourceURL=${pathToFileURL(path.join(__dirname, "highlightTarget.js")).href}</script></body>`,
    { url, runScripts: "dangerously" },
  );
  fn(dom.window);
}

describe("consumeQueryParam", () => {
  test("reads and removes the param without reloading the page", () => {
    withDom(
      "http://localhost/html/dashboard.html?highlightCourse=7&tab=hours",
      (window) => {
        expect(
          window.__highlightTarget.consumeQueryParam("highlightCourse"),
        ).toBe("7");
        // Removed from the URL, the other param kept, no reload.
        expect(window.location.search).toBe("?tab=hours");
        // A second read gets nothing, so refreshing can't re-trigger.
        expect(
          window.__highlightTarget.consumeQueryParam("highlightCourse"),
        ).toBeNull();
      },
    );
  });

  test("drops the ? entirely when it was the only param", () => {
    withDom(
      "http://localhost/html/dashboard.html?highlightCourse=3",
      (window) => {
        window.__highlightTarget.consumeQueryParam("highlightCourse");
        expect(window.location.search).toBe("");
      },
    );
  });

  test("returns null when the param isn't present", () => {
    withDom("http://localhost/html/dashboard.html", (window) => {
      expect(
        window.__highlightTarget.consumeQueryParam("highlightCourse"),
      ).toBeNull();
    });
  });
});

describe("scrollAndHighlight", () => {
  test("scrolls the element into view and flashes it briefly", () => {
    withDom("http://localhost/html/dashboard.html", (window) => {
      jest.useFakeTimers();
      const el = window.document.getElementById("target");
      // jsdom doesn't implement scrollIntoView.
      el.scrollIntoView = jest.fn();

      window.__highlightTarget.scrollAndHighlight(el);

      expect(el.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "center",
      });
      expect(el.classList.contains("highlight-flash")).toBe(true);

      jest.advanceTimersByTime(2500);
      expect(el.classList.contains("highlight-flash")).toBe(false);
      jest.useRealTimers();
    });
  });

  test("silently ignores a missing target", () => {
    withDom("http://localhost/html/dashboard.html", (window) => {
      expect(() =>
        window.__highlightTarget.scrollAndHighlight(null),
      ).not.toThrow();
    });
  });
});
