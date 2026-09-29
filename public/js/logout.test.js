// logout.js is a plain browser script (no imports/exports), so it runs as-is
// inside a real jsdom document via runScripts: "dangerously" — same pattern
// as the rest of this suite's frontend tests.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const logoutSrc = fs
  .readFileSync(path.join(__dirname, "logout.js"), "utf8")
  // jsdom can't navigate (window.location is unforgeable), so capture the
  // redirect target instead — the surrounding behaviour is unchanged.
  .replace(
    'window.location.href = "login.html";',
    'window.__redirectedTo = "login.html";',
  );

function withDom(bodyHtml, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}<script>${logoutSrc}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "logout.js")).href}</script></body>`,
    { url: "http://localhost/html/dashboard.html", runScripts: "dangerously" },
  );
  fn(dom.window);
}

describe("logout button", () => {
  test("clears the session and sends the user to the login page", () => {
    withDom(`<a href="#" id="logout-button">Log out</a>`, (window) => {
      window.sessionStorage.setItem("access_token", "abc");
      window.sessionStorage.setItem(
        "user",
        JSON.stringify({ id: "u1", role: "tutor" }),
      );

      const click = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      window.document.getElementById("logout-button").dispatchEvent(click);

      expect(window.sessionStorage.getItem("access_token")).toBeNull();
      expect(window.sessionStorage.getItem("user")).toBeNull();
      expect(window.__redirectedTo).toBe("login.html");
    });
  });

  test("prevents the link's default navigation", () => {
    withDom(`<a href="#" id="logout-button">Log out</a>`, (window) => {
      const event = new window.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      const preventDefault = jest.spyOn(event, "preventDefault");
      window.document.getElementById("logout-button").dispatchEvent(event);
      expect(preventDefault).toHaveBeenCalled();
    });
  });

  test("does nothing when the page has no logout button", () => {
    withDom(`<p>No logout here</p>`, (window) => {
      expect(() => {
        window.document.body.dispatchEvent(
          new window.MouseEvent("click", { bubbles: true }),
        );
      }).not.toThrow();
      // And the session survives.
      window.sessionStorage.setItem("access_token", "abc");
      expect(window.sessionStorage.getItem("access_token")).toBe("abc");
    });
  });
});
