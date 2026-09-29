// user-badge.js is a plain browser script (no imports/exports), so it runs
// as-is inside a real jsdom document via runScripts: "dangerously" — same
// pattern as the rest of this suite's frontend tests.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const src = fs.readFileSync(path.join(__dirname, "user-badge.js"), "utf8");

function withDom(bodyHtml, sessionStorageUser, fn) {
  const dom = new JSDOM(
    `<body>${bodyHtml}<script>${src}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "user-badge.js")).href}</script></body>`,
    {
      url: "http://localhost/html/dashboard.html",
      runScripts: "dangerously",
      beforeParse(window) {
        if (sessionStorageUser != null) {
          window.sessionStorage.setItem(
            "user",
            JSON.stringify(sessionStorageUser),
          );
        }
      },
    },
  );
  fn(dom.window);
}

describe("user badge", () => {
  test("fills the name and role pill from the signed-in user", () => {
    withDom(
      `<span id="user-name"></span><span id="user-role-badge"></span>`,
      { name: "Thandi M", role: "tutor" },
      (window) => {
        const doc = window.document;
        expect(doc.getElementById("user-name").textContent).toBe("Thandi M");
        expect(doc.getElementById("user-role-badge").textContent).toBe("Tutor");
      },
    );
  });

  test("shows legacy 'student' accounts as volunteers", () => {
    withDom(
      `<span id="user-name"></span><span id="user-role-badge"></span>`,
      { name: "Sam", role: "student" },
      (window) => {
        expect(
          window.document.getElementById("user-role-badge").textContent,
        ).toBe("Volunteer");
      },
    );
  });

  test("presents the super_organiser role in readable title case", () => {
    withDom(
      `<span id="user-name"></span><span id="user-role-badge"></span>`,
      { name: "Ada", role: "super_organiser" },
      (window) => {
        expect(
          window.document.getElementById("user-role-badge").textContent,
        ).toBe("Super organiser");
      },
    );
  });

  test("reveals super-organiser-only nav links", () => {
    withDom(
      `<a data-super-only href="#" hidden>Organiser Requests</a><span id="user-role-badge"></span>`,
      { name: "Ada", role: "super_organiser" },
      (window) => {
        expect(window.document.querySelector("[data-super-only]").hidden).toBe(
          false,
        );
      },
    );
  });

  test("leaves super-organiser-only links hidden for everyone else", () => {
    withDom(
      `<a data-super-only href="#" hidden>Organiser Requests</a><span id="user-role-badge"></span>`,
      { name: "Sam", role: "tutor" },
      (window) => {
        expect(window.document.querySelector("[data-super-only]").hidden).toBe(
          true,
        );
      },
    );
  });

  test("falls back to 'Account' and 'Member' for a bare user object", () => {
    withDom(
      `<span id="user-name"></span><span id="user-role-badge"></span>`,
      {},
      (window) => {
        const doc = window.document;
        expect(doc.getElementById("user-name").textContent).toBe("Account");
        expect(doc.getElementById("user-role-badge").textContent).toBe(
          "Member",
        );
      },
    );
  });

  test("does nothing when no user is signed in", () => {
    withDom(
      `<span id="user-name">placeholder</span><span id="user-role-badge">badge</span>`,
      null,
      (window) => {
        const doc = window.document;
        expect(doc.getElementById("user-name").textContent).toBe("placeholder");
        expect(doc.getElementById("user-role-badge").textContent).toBe("badge");
      },
    );
  });

  test("survives a corrupt session user and leaves the markup alone", () => {
    const dom = new JSDOM(
      `<body><span id="user-name">placeholder</span><span id="user-role-badge"></span><script>${src}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "user-badge.js")).href}</script></body>`,
      {
        url: "http://localhost/html/dashboard.html",
        runScripts: "dangerously",
        beforeParse(window) {
          window.sessionStorage.setItem("user", "{corrupt");
        },
      },
    );
    const doc = dom.window.document;
    expect(doc.getElementById("user-name").textContent).toBe("placeholder");
  });
});
