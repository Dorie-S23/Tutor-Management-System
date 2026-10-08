// profile.js is a real ES module (imports from ./storage.js and ./nav.js),
// so — same approach as studentview.dashboard.test.js — it's loaded as a
// classic script with the imports stripped and stub functions injected
// ahead of it. profile.html (tutor) and student-profile.html (student
// volunteer) are loaded as real HTML in jsdom and driven through real
// fetch/submit calls rather than unit-tested in isolation.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const tutorHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "profile.html"),
  "utf8",
);
const studentHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "student-profile.html"),
  "utf8",
);
const organiserHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "organiser-profile.html"),
  "utf8",
);
const profileSrc = fs
  .readFileSync(path.join(__dirname, "profile.js"), "utf8")
  .replace(
    /^import \{[^}]*\} from ".\/(?:storage|nav|profile-timetable)\.js";$/gm,
    "",
  );

// The timetable card has its own tests (profile-timetable.test.js), so it's
// stubbed out here to keep these focused on the details form.
function makeStubs(user) {
  return `
function requireRole() { return ${JSON.stringify(user)}; }
function highlightActiveTab() {}
function initProfileTimetable() {}
`;
}

function loadPage({
  file = "student-profile.html",
  user = { id: "student-1", name: "Test Student", role: "student" },
  profile = null,
  loadError = null,
  saveError = null,
} = {}) {
  const html =
    file === "profile.html"
      ? tutorHtml
      : file === "organiser-profile.html"
        ? organiserHtml
        : studentHtml;
  const resolvedProfile = profile || {
    id: user.id,
    name:
      user.role === "tutor"
        ? "Test Tutor"
        : user.role === "organiser"
          ? "Test Organiser"
          : "Test Student",
    email:
      user.role === "tutor"
        ? "tutor@wits.ac.za"
        : user.role === "organiser"
          ? "organiser@wits.ac.za"
          : "student@students.wits.ac.za",
    studentNumber: user.role === "organiser" ? "" : "1234567",
    cellPhone: "082 123 4567",
    role: user.role,
  };

  const script = `<script>${makeStubs(user)}\n${profileSrc}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "profile.js")).href}</script>`;
  const pageHtml = html
    .replace('<script type="module" src="../js/profile.js"></script>', script)
    .replace('<script src="../js/user-badge.js"></script>', "")
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
  test("declares the volunteer role so requireRole() lets volunteers through", () => {
    expect(studentHtml).toContain('data-page-role="volunteer"');
  });

  test("prefills the form from the saved profile with the email read-only", async () => {
    const { window } = loadPage();
    await wait();

    // "Test Student" splits into the first/last fields at the first space.
    expect(window.document.getElementById("profile-first-name").value).toBe(
      "Test",
    );
    expect(window.document.getElementById("profile-last-name").value).toBe(
      "Student",
    );
    // The banner identity row mirrors the same profile.
    expect(
      window.document.getElementById("profile-display-name").textContent,
    ).toBe("Test Student");
    expect(
      window.document.getElementById("profile-avatar-initials").textContent,
    ).toBe("TS");
    expect(
      window.document.getElementById("profile-display-student-number")
        .textContent,
    ).toBe("1234567");
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

    // Rename to a single name — clear the prefilled last name so the join
    // sends just "Samuel".
    window.document.getElementById("profile-first-name").value = "Samuel";
    window.document.getElementById("profile-last-name").value = "";
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

    // The session copy and banner identity follow the new name.
    expect(JSON.parse(window.sessionStorage.getItem("user")).name).toBe(
      "Samuel",
    );
    expect(
      window.document.getElementById("profile-display-name").textContent,
    ).toBe("Samuel");
    expect(
      window.document.getElementById("profile-avatar-initials").textContent,
    ).toBe("SA");
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
    expect(window.document.getElementById("profile-first-name").value).toBe(
      "Test",
    );
    expect(window.document.getElementById("profile-last-name").value).toBe(
      "Tutor",
    );
    expect(window.document.getElementById("profile-email").value).toBe(
      "tutor@wits.ac.za",
    );
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });
});

describe("profile.js — organiser page", () => {
  test("declares both organiser roles so requireRole() lets either through", () => {
    expect(organiserHtml).toContain(
      'data-page-role="organiser,super_organiser"',
    );
  });

  test("prefills name, email and cell phone with the student number field hidden", async () => {
    const { window, calls } = loadPage({
      file: "organiser-profile.html",
      user: { id: "organiser-1", name: "Test Organiser", role: "organiser" },
    });
    await wait();

    expect(calls[0].url).toContain("/api/profile/organiser-1");
    expect(window.document.getElementById("profile-first-name").value).toBe(
      "Test",
    );
    expect(window.document.getElementById("profile-last-name").value).toBe(
      "Organiser",
    );
    expect(window.document.getElementById("profile-email").value).toBe(
      "organiser@wits.ac.za",
    );
    // The field still exists (profile.js reads it unconditionally) but the
    // page hides it — organisers have no student number.
    expect(
      window.document
        .getElementById("profile-student-number")
        .closest(".form-field").hidden,
    ).toBe(true);
    expect(window.document.getElementById("profile-save-btn").disabled).toBe(
      false,
    );
  });

  test("saves without a student number in the payload", async () => {
    const { window, calls } = loadPage({
      file: "organiser-profile.html",
      user: { id: "organiser-1", name: "Test Organiser", role: "organiser" },
    });
    await wait();

    window.document.getElementById("profile-cell-phone").value = "083 999 0000";

    window.document
      .getElementById("profile-form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    await wait();

    const putCall = calls.find((c) => c.opts?.method === "PUT");
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall.opts.body)).toEqual({
      name: "Test Organiser",
      studentNumber: "",
      cellPhone: "083 999 0000",
    });
    expect(window.document.getElementById("toast").textContent).toContain(
      "saved",
    );
  });
});
