// profile.js is a real ES module (imports from ./storage.js and ./nav.js),
// so — same approach as studentview.dashboard.test.js — it's loaded as a
// classic script with the imports stripped and stub functions injected
// ahead of it. profile.html (tutor) and student-profile.html (student
// volunteer) are loaded as real HTML in jsdom and driven through real
// fetch/submit calls rather than unit-tested in isolation.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const tutorHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "profile.html"),
  "utf8",
);
const studentHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "student-profile.html"),
  "utf8",
);
const profileSrc = fs
  .readFileSync(path.join(__dirname, "profile.js"), "utf8")
  .replace(/^import \{[^}]*\} from ".\/(?:storage|nav)\.js";$/gm, "");

function makeStubs(user) {
  return `
function requireRole() { return ${JSON.stringify(user)}; }
function highlightActiveTab() {}
function renderWelcomeHeading(name) { window.__welcomeHeading = name; }
`;
}

function loadPage({
  file = "student-profile.html",
  user = { id: "student-1", name: "Test Student", role: "student" },
  profile = null,
  loadError = null,
  saveError = null,
} = {}) {
  const html = file === "profile.html" ? tutorHtml : studentHtml;
  const resolvedProfile = profile || {
    id: user.id,
    name: user.role === "tutor" ? "Test Tutor" : "Test Student",
    email:
      user.role === "tutor"
        ? "tutor@wits.ac.za"
        : "student@students.wits.ac.za",
    studentNumber: "1234567",
    cellPhone: "082 123 4567",
    role: user.role,
  };

  const script = `<script>${makeStubs(user)}\n${profileSrc}\n</script>`;
  const pageHtml = html
    .replace('<script type="module" src="../js/profile.js"></script>', script)
    .replace('<script src="../js/notifications.js"></script>', "")
    .replace('<script src="../js/logout.js"></script>', "");

  const calls = [];

  const dom = new JSDOM(pageHtml, {
    url: `http://localhost/${file}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.sessionStorage.setItem("user", JSON.stringify(user));
      window.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        const u = String(url);
        if (!u.includes("/api/profile/")) {
          return { ok: true, json: async () => [] };
        }
        if (opts?.method === "PUT") {
          if (saveError) {
            return { ok: false, json: async () => ({ error: saveError }) };
          }
          const posted = JSON.parse(opts.body);
          return {
            ok: true,
            json: async () => ({ ...resolvedProfile, ...posted }),
          };
        }
        if (loadError) {
          return { ok: false, json: async () => ({ error: loadError }) };
        }
        return { ok: true, json: async () => resolvedProfile };
      };
    },
  });

  return { window: dom.window, calls };
}

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function submitForm(window) {
  window.document
    .getElementById("profile-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
}

describe("profile.js — student volunteer page", () => {
  test("prefills the form from the saved profile with the email read-only", async () => {
    const { window } = loadPage();
    await wait();

    expect(window.document.getElementById("profile-name").value).toBe(
      "Test Student",
    );
    expect(window.document.getElementById("profile-email").value).toBe(
      "student@students.wits.ac.za",
    );
    expect(window.document.getElementById("profile-student-number").value).toBe(
      "1234567",
    );
    expect(window.document.getElementById("profile-cell-phone").value).toBe(
      "082 123 4567",
    );

    expect(window.document.getElementById("profile-email").readOnly).toBe(true);
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });

  test("submitting saves through the API, updates the session name and toasts", async () => {
    const { window, calls } = loadPage();
    await wait();

    window.document.getElementById("profile-name").value = "Samuel";
    window.document.getElementById("profile-student-number").value = "7654322";
    window.document.getElementById("profile-cell-phone").value =
      "+27 82 555 1234";

    submitForm(window);
    await wait();

    const putCall = calls.find((c) => c.opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(putCall.url).toContain("/api/profile/student-1");
    expect(JSON.parse(putCall.opts.body)).toEqual({
      name: "Samuel",
      studentNumber: "7654322",
      cellPhone: "+27 82 555 1234",
    });

    // The session copy and welcome heading follow the new name.
    expect(JSON.parse(window.sessionStorage.getItem("user")).name).toBe(
      "Samuel",
    );
    expect(window.__welcomeHeading).toBe("Samuel");
    expect(window.document.getElementById("toast").textContent).toContain(
      "saved",
    );
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });

  test("shows the server's error when saving fails", async () => {
    const { window } = loadPage({
      saveError: "That student number is already used by another account",
    });
    await wait();

    submitForm(window);
    await wait();

    const errorEl = window.document.getElementById("profile-error");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("already used by another account");
    // Still usable — the user can correct the number and try again.
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });

  test("rejects an invalid South African cell number before calling the API", async () => {
    const { window, calls } = loadPage();
    await wait();

    // A Cape Town landline — a valid SA number, but not a cell.
    window.document.getElementById("profile-cell-phone").value = "021 123 4567";

    submitForm(window);
    await wait();

    const errorEl = window.document.getElementById("profile-error");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("South African cell phone number");
    // No PUT was attempted, and the form is still usable.
    expect(calls.find((c) => c.opts?.method === "PUT")).toBeUndefined();
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });

  test("a failed load shows the error and keeps the form locked", async () => {
    const { window } = loadPage({ loadError: "User not found" });
    await wait();

    const errorEl = window.document.getElementById("profile-error");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("User not found");
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      true,
    );
  });
});

describe("profile.js — tutor page", () => {
  test("uses the same form wired to the tutor's own profile", async () => {
    const { window, calls } = loadPage({
      file: "profile.html",
      user: { id: "tutor-1", name: "Test Tutor", role: "tutor" },
    });
    await wait();

    expect(calls[0].url).toContain("/api/profile/tutor-1");
    expect(window.document.getElementById("profile-name").value).toBe(
      "Test Tutor",
    );
    expect(window.document.getElementById("profile-email").value).toBe(
      "tutor@wits.ac.za",
    );
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });
});
