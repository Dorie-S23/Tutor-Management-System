// auth.js is a plain browser script (no module.exports, wires itself up via
// getElementById + addEventListener at load time), so — as with
// board.keyboard-nav.test.js — we load the real register.html + auth.js
// into an actual jsdom document and drive the real form submit event,
// rather than re-implementing the registration logic in the test.
//
// Signup accepts any email domain (e.g. gmail.com) — these tests lock that
// in by driving the real form with non-Wits addresses and asserting the
// registration request reaches the API.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const registerHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "register.html"),
  "utf8",
);
const authJs = fs.readFileSync(path.join(__dirname, "auth.js"), "utf8");

function loadRegisterPage() {
  const html = registerHtml.replace(
    '<script src="../js/auth.js"></script>',
    `<script>${authJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "auth.js")).href}</script>`,
  );

  const fetchMock = jest.fn(
    () => new Promise(() => {}), // registration's own success/failure path isn't under test here — never resolving keeps the "Creating your account..." state without needing a fake API response.
  );

  const dom = new JSDOM(html, {
    url: "http://localhost/register.html",
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = fetchMock;
    },
  });

  return { window: dom.window, fetchMock };
}

function fillAndSubmit(window, { email = "someone@gmail.com" } = {}) {
  const doc = window.document;
  doc.getElementById("name").value = "Test User";
  doc.getElementById("email").value = email;
  doc.getElementById("password").value = "correct horse battery staple";
  doc.getElementById("confirm-password").value = "correct horse battery staple";
  doc.getElementById("role").value = "volunteer";
  doc.getElementById("student-number").value = "1234567";

  const form = doc.getElementById("register-form");
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registration email acceptance", () => {
  test("a @gmail.com address is accepted and sent to the API", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "someone@gmail.com" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const message = window.document.getElementById("register-message");
    expect(message.textContent).toBe("Creating your account...");
  });

  test("a @students.wits.ac.za address is still accepted", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "someone@students.wits.ac.za" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a plain @wits.ac.za address is still accepted", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "staff.member@wits.ac.za" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
