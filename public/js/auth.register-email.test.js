// auth.js is a plain browser script (no module.exports, wires itself up via
// getElementById + addEventListener at load time), so — as with
// board.keyboard-nav.test.js — we load the real register.html + auth.js
// into an actual jsdom document and drive the real form submit event,
// rather than re-implementing the validation logic in the test.
//
// This suite exists because of a real production bug: `!email.toLowerCase
// .endsWith(...)` (missing the call parens on the first toLowerCase) threw
// `TypeError: email.toLowerCase.endsWith is not a function` on submit —
// but only for emails that reach that second check at all, i.e. anything
// *not* ending in plain "@wits.ac.za" (like the "@students.wits.ac.za"
// addresses students actually register with), which is exactly why it
// slipped through onto a form that "worked" for some emails and not others.
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
    `<script>\n${authJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "auth.js")).href}\n</script>`,
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

function fillAndSubmit(window, { email = "someone@students.wits.ac.za" } = {}) {
  const doc = window.document;
  doc.getElementById("name").value = "Test User";
  doc.getElementById("email").value = email;
  doc.getElementById("password").value = "correct horse battery staple";
  doc.getElementById("confirm-password").value = "correct horse battery staple";
  doc.getElementById("role").value = "student";
  doc.getElementById("student-number").value = "1234567";

  const form = doc.getElementById("register-form");
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registration Wits-email validation", () => {
  test("a @students.wits.ac.za address is accepted (the exact case the toLowerCase typo broke)", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "someone@students.wits.ac.za" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const message = window.document.getElementById("register-message");
    expect(message.textContent).toBe("Creating your account...");
  });

  test("a plain @wits.ac.za address is accepted", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "staff.member@wits.ac.za" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("matching is case-insensitive", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "Someone@STUDENTS.WITS.AC.ZA" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a non-Wits address is rejected without ever calling the API", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "someone@gmail.com" });
    await ready();

    expect(fetchMock).not.toHaveBeenCalled();
    const message = window.document.getElementById("register-message");
    expect(message.textContent).toBe("Please use a Wits email address.");
    expect(message.style.color).toBe("red");
  });

  test("an address merely containing 'wits.ac.za' outside the domain is still rejected", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { email: "wits.ac.za@evil-example.com" });
    await ready();

    expect(fetchMock).not.toHaveBeenCalled();
    const message = window.document.getElementById("register-message");
    expect(message.textContent).toBe("Please use a Wits email address.");
  });
});
