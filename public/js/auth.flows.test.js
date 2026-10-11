// Login + registration behaviour of auth.js that auth.register-email.test.js
// doesn't cover: role-based redirect after login, session storage, login
// errors, the forgot-password pointer, the Google hand-off, the ?authError=
// round-trip, and the register page's role toggles / organiser course list.
//
// Same harness as the other auth suite: real HTML pages + the real auth.js
// inlined into the document, driving real DOM events. jsdom can't navigate
// (window.location is unforgeable), so every `window.location.href = ...`
// assignment is rewritten to record its target on `window.__lastRedirect`
// instead — same lines, so the v8 coverage layout is unchanged. auth.js
// schedules its redirects with setTimeout, which is captured so tests can
// fire the callbacks deterministically instead of waiting out the
// 1000/1500ms delays; the ?authError= cleanup's history.replaceState is left
// real because jsdom can do same-document history without navigation.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const loginHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "login.html"),
  "utf8",
);
const registerHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "register.html"),
  "utf8",
);
const authJs = fs
  .readFileSync(path.join(__dirname, "auth.js"), "utf8")
  .replace(
    /window\.location\.href = ("(?:[^"\\]|\\.)*");/g,
    "window.__lastRedirect = $1;",
  );
const sourceUrl = pathToFileURL(path.join(__dirname, "auth.js")).href;

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Loads one of the auth pages with auth.js inlined. fetchMock is jest.fn()
 * (never-resolving unless the test overrides it) and `timers` collects the
 * setTimeout callbacks the script schedules.
 */
function loadPage(
  html,
  { url = "http://localhost/login.html", fetchMock } = {},
) {
  const markup = html.replace(
    '<script src="../js/auth.js"></script>',
    `<script>${authJs}\n//# sourceURL=${sourceUrl}</script>`,
  );
  const timers = [];
  const dom = new JSDOM(markup, {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = fetchMock;
      window.setTimeout = (fn) => {
        timers.push(fn);
        return timers.length;
      };
    },
  });
  return { window: dom.window, timers };
}

function submitLogin(
  window,
  { email = "tutor@wits.ac.za", password = "secret123" } = {},
) {
  const doc = window.document;
  doc.getElementById("email").value = email;
  doc.getElementById("password").value = password;
  doc
    .getElementById("login-form")
    .dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
}

function loginBody(role) {
  return {
    session: { access_token: `token-for-${role}` },
    user: { id: `u-${role}`, role },
  };
}

describe("login success and role-based redirect", () => {
  const cases = [
    ["student", "StudentView.html"],
    ["volunteer", "StudentView.html"],
    ["tutor", "dashboard.html"],
    ["educator", "educator.html"],
    ["organiser", "board.html"],
    ["super_organiser", "board.html"],
    ["proctor", "index.html"],
  ];

  for (const [role, target] of cases) {
    test(`${role} lands on ${target}`, async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => loginBody(role),
      });
      const { window, timers } = loadPage(loginHtml, { fetchMock });

      submitLogin(window);
      await wait();

      expect(window.document.getElementById("login-message").textContent).toBe(
        "Login successful!",
      );

      // Redirect is deferred — nothing moves until the timer fires.
      expect(window.__lastRedirect).toBeUndefined();
      timers.shift()();
      expect(window.__lastRedirect).toBe(target);
    });
  }

  test("token and user land in sessionStorage", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => loginBody("tutor"),
    });
    const { window } = loadPage(loginHtml, { fetchMock });

    submitLogin(window);
    await wait();

    expect(window.sessionStorage.getItem("access_token")).toBe(
      "token-for-tutor",
    );
    expect(JSON.parse(window.sessionStorage.getItem("user"))).toEqual({
      id: "u-tutor",
      role: "tutor",
    });
  });
});

describe("login failure paths", () => {
  test("a rejected login shows the API's error message", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Invalid login credentials" }),
    });
    const { window } = loadPage(loginHtml, { fetchMock });

    submitLogin(window);
    await wait();

    expect(window.document.getElementById("login-message").textContent).toBe(
      "Invalid login credentials",
    );
    expect(window.__lastRedirect).toBeUndefined();
  });

  test("an unreachable server shows the connection message", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { window } = loadPage(loginHtml, { fetchMock });

    submitLogin(window);
    await wait();

    expect(window.document.getElementById("login-message").textContent).toBe(
      "Unable to connect to the server.",
    );
  });
});

describe("login page extras", () => {
  test("forgot-password points at the course administrator", () => {
    const { window } = loadPage(loginHtml, { fetchMock: jest.fn() });

    window.document
      .getElementById("forgot-password-link")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(window.document.getElementById("login-message").textContent).toBe(
      "Please contact your course administrator to reset your password.",
    );
  });

  test("the Google button hands off to the OAuth start endpoint", async () => {
    const { window } = loadPage(loginHtml, { fetchMock: jest.fn() });

    window.document
      .getElementById("google-register-button")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await wait();

    expect(window.__lastRedirect).toBe("/api/auth/google");
  });

  test("?authError= is shown once and stripped from the address bar", () => {
    const { window } = loadPage(loginHtml, {
      fetchMock: jest.fn(),
      url: "http://localhost/login.html?authError=Google%20sign-in%20cancelled&next=1",
    });

    expect(window.document.getElementById("login-message").textContent).toBe(
      "Google sign-in cancelled",
    );
    // replaceState dropped the param but kept the rest of the query.
    expect(window.location.search).toBe("?next=1");
  });
});

describe("register page role toggles", () => {
  test("tutor shows and requires the student number field", () => {
    const { window } = loadPage(registerHtml, { fetchMock: jest.fn() });
    const doc = window.document;
    const group = doc.getElementById("student-number-group");
    const input = doc.getElementById("student-number");

    doc.getElementById("role").value = "tutor";
    doc
      .getElementById("role")
      .dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(group.style.display).toBe("block");
    expect(input.required).toBe(true);
  });

  test("organiser hides the student number, shows the course picker and loads courses once", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 5, course_code: "COMS1016A", course_name: "Intro to CS" },
        { id: 9, course_code: "MATH2001", course_name: "Linear Algebra" },
      ],
    });
    const { window } = loadPage(registerHtml, { fetchMock });
    const doc = window.document;
    const roleSelect = doc.getElementById("role");

    roleSelect.value = "organiser";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait();

    expect(doc.getElementById("student-number-group").style.display).toBe(
      "none",
    );
    expect(doc.getElementById("course-group").style.display).toBe("block");
    expect(doc.getElementById("course").required).toBe(true);

    const options = [...doc.getElementById("course").options];
    expect(options[options.length - 2].textContent).toBe(
      "COMS1016A — Intro to CS",
    );
    expect(options[options.length - 2].value).toBe("5");
    expect(options[options.length - 1].textContent).toBe(
      "MATH2001 — Linear Algebra",
    );

    // Flipping away and back must not fetch the course list again.
    roleSelect.value = "tutor";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    roleSelect.value = "organiser";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("an error response from the course register surfaces its message", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Course register offline" }),
    });
    const { window } = loadPage(registerHtml, { fetchMock });
    const doc = window.document;

    doc.getElementById("role").value = "organiser";
    doc
      .getElementById("role")
      .dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait();

    expect(doc.getElementById("register-message").textContent).toBe(
      "Couldn't load the course list — please try again.",
    );
  });

  test("a failed course load shows an error and is retried on the next pick", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 5, course_code: "COMS1016A", course_name: "Intro to CS" },
        ],
      });
    const { window } = loadPage(registerHtml, { fetchMock });
    const doc = window.document;
    const roleSelect = doc.getElementById("role");

    roleSelect.value = "organiser";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait();

    expect(doc.getElementById("register-message").textContent).toBe(
      "Couldn't load the course list — please try again.",
    );

    roleSelect.value = "tutor";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    roleSelect.value = "organiser";
    roleSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const options = [...doc.getElementById("course").options];
    expect(options[options.length - 1].value).toBe("5");
  });
});

describe("register submission validation", () => {
  function loadRegister() {
    const fetchMock = jest.fn(() => new Promise(() => {}));
    const page = loadPage(registerHtml, { fetchMock });
    return { fetchMock, ...page };
  }

  function submit(window, overrides = {}) {
    const doc = window.document;
    const fields = {
      name: "Test User",
      email: "new.user@wits.ac.za",
      password: "correct horse battery staple",
      "confirm-password": "correct horse battery staple",
      role: "volunteer",
      "student-number": "1234567",
      ...overrides,
    };
    for (const [id, value] of Object.entries(fields)) {
      doc.getElementById(id).value = value;
    }
    doc
      .getElementById("register-form")
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  }

  test("mismatched passwords are rejected before any request", () => {
    const { window, fetchMock } = loadRegister();

    submit(window, { "confirm-password": "different" });

    expect(window.document.getElementById("register-message").textContent).toBe(
      "Passwords do not match.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a volunteer without a student number is rejected", () => {
    const { window, fetchMock } = loadRegister();

    submit(window, { "student-number": "" });

    expect(window.document.getElementById("register-message").textContent).toBe(
      "Student number is required for volunteers and tutors.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an organiser without a course is rejected", () => {
    const { window, fetchMock } = loadRegister();

    submit(window, { role: "organiser", "student-number": "" });

    expect(window.document.getElementById("register-message").textContent).toBe(
      "Choose the course you want to organise.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a successful volunteer signup redirects to the login page", async () => {
    const { window, fetchMock, timers } = loadRegister();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "u-new" } }),
    });

    submit(window);
    await wait();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0];
    expect(requestUrl).toBe("/api/auth/register");
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody).toMatchObject({
      name: "Test User",
      email: "new.user@wits.ac.za",
      role: "volunteer",
      studentNumber: "1234567",
    });
    // Non-organisers send no course at all — JSON.stringify drops the key.
    expect(sentBody).not.toHaveProperty("courseId");
    expect(window.document.getElementById("register-message").textContent).toBe(
      "Registration successful! Redirecting to login...",
    );

    timers.shift()();
    expect(window.__lastRedirect).toBe("login.html");
  });

  test("an organiser signup sends the numeric course id and waits for approval", async () => {
    const { window, fetchMock } = loadRegister();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ user: { id: "u-org" } }),
    });

    // The course list is only fetched when the organiser role is picked,
    // so seed the option the submit handler will read.
    const option = window.document.createElement("option");
    option.value = "5";
    window.document.getElementById("course").appendChild(option);

    submit(window, { role: "organiser", course: "5", "student-number": "" });
    await wait();

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(requestInit.body).courseId).toBe(5);
    expect(window.document.getElementById("register-message").textContent).toBe(
      "Registration successful! Your organiser request is awaiting approval — you can sign in once it's approved.",
    );
  });

  test("an API rejection shows the server's error message", async () => {
    const { window } = loadRegister();
    window.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Email already registered" }),
    });

    submit(window);
    await wait();
    expect(window.document.getElementById("register-message").textContent).toBe(
      "Email already registered",
    );
  });

  test("a network failure shows the connection message", async () => {
    const { window } = loadRegister();
    window.fetch.mockRejectedValue(new Error("offline"));

    submit(window);
    await wait();

    expect(window.document.getElementById("register-message").textContent).toBe(
      "Unable to connect to the server.",
    );
  });
});
