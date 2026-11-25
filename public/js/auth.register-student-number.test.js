// The student-number counterpart to auth.register-email.test.js: loads the
// real register.html + auth.js into an actual jsdom document and drives the
// real form submit event. Locks in the rule that a volunteer's or tutor's
// student number is five to seven digits, numbers only — the server
// enforces the same rule.
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
    () => new Promise(() => {}), // a valid submission's success path isn't under test here — never resolving keeps the "Creating your account..." state without needing a fake API response.
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

function fillAndSubmit(window, { studentNumber = "1234567" } = {}) {
  const doc = window.document;
  doc.getElementById("name").value = "Test User";
  doc.getElementById("email").value = "someone@gmail.com";
  doc.getElementById("password").value = "correct horse battery staple";
  doc.getElementById("confirm-password").value = "correct horse battery staple";
  doc.getElementById("role").value = "volunteer";
  doc.getElementById("student-number").value = studentNumber;

  doc
    .getElementById("register-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
}

function ready() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registration student number validation", () => {
  test.each([
    ["too long", "12345678"],
    ["too short", "123"],
    ["contains letters", "2033a44"],
  ])(
    "a student number that is %s is rejected before the API is called",
    async (_label, studentNumber) => {
      const { window, fetchMock } = loadRegisterPage();
      fillAndSubmit(window, { studentNumber });
      await ready();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        window.document.getElementById("register-message").textContent,
      ).toBe("Student number must be 5–7 digits.");
    },
  );

  test("a 7-digit student number still reaches the API", async () => {
    const { window, fetchMock } = loadRegisterPage();
    fillAndSubmit(window, { studentNumber: "2033344" });
    await ready();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
