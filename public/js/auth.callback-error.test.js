// A failed Google sign-in used to strand the person on google-callback.html's
// "Signing you in..." spinner. It now bounces back to login.html with the
// reason in ?authError=, which auth.js surfaces in the login card.
//
// Both pages are plain browser scripts, so — as with
// auth.register-email.test.js and logout.test.js — the real HTML is loaded
// into jsdom. Supabase's CDN script is dropped in favour of a stub, and
// window.location.href assignments are rewritten to a capture variable
// because jsdom can't navigate.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pathToFileURL } = require("url");

const callbackHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "google-callback.html"),
  "utf8",
);
const loginHtml = fs.readFileSync(
  path.join(__dirname, "..", "html", "login.html"),
  "utf8",
);
const authJs = fs.readFileSync(path.join(__dirname, "auth.js"), "utf8");

function fakeSupabase({ exchangeError, sessionResult, profileResult }) {
  return {
    auth: {
      exchangeCodeForSession: jest.fn(async () => ({
        data: null,
        error: exchangeError || null,
      })),
      getSession: jest.fn(async () => sessionResult),
      signOut: jest.fn(async () => ({ error: null })),
    },
    // Chain covers both lookups: users -> maybeSingle(), and the organiser
    // requests query, which is awaited directly.
    from: jest.fn(() => ({
      select: () => ({
        eq: () =>
          Object.assign(async () => profileResult, {
            maybeSingle: async () => profileResult,
          }),
      }),
    })),
  };
}

function loadCallbackPage(client, search = "") {
  const html = callbackHtml
    .replace(
      '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
      "",
    )
    .replace(/window\.location\.href = /g, "window.__redirectedTo = ");

  const dom = new JSDOM(html, {
    url: `http://localhost/html/google-callback.html${search}`,
    runScripts: "dangerously",
    // The error paths console.error on purpose — keep that out of the report.
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.supabase = { createClient: () => client };
    },
  });

  return dom.window;
}

function loadLoginPage(search = "") {
  const html = loginHtml.replace(
    '<script src="../js/auth.js"></script>',
    `<script>${authJs}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "auth.js")).href}</script>`,
  );

  const dom = new JSDOM(html, {
    url: `http://localhost/html/login.html${search}`,
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
  });

  return dom.window;
}

// handleGoogleCallback awaits several stubbed calls, so let the microtask
// queue drain before asserting.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("google-callback.html failures", () => {
  test("a rejected code exchange goes back to login with the reason", async () => {
    const window = loadCallbackPage(
      fakeSupabase({
        exchangeError: new Error("invalid code"),
        sessionResult: { data: { session: null }, error: null },
      }),
      "?code=abc123",
    );
    await settle();

    expect(window.__redirectedTo).toBe(
      "/html/login.html?authError=Could+not+complete+Google+sign-in.",
    );
  });

  test("a missing session goes back to login", async () => {
    const window = loadCallbackPage(
      fakeSupabase({ sessionResult: { data: { session: null }, error: null } }),
    );
    await settle();

    expect(window.__redirectedTo).toBe(
      "/html/login.html?authError=No+authenticated+user+was+found.",
    );
  });

  test("a failed profile lookup goes back to login", async () => {
    const window = loadCallbackPage(
      fakeSupabase({
        sessionResult: {
          data: { session: { access_token: "tok", user: { id: "u1" } } },
          error: null,
        },
        profileResult: { data: null, error: new Error("permission denied") },
      }),
    );
    await settle();

    expect(window.__redirectedTo).toBe(
      "/html/login.html?authError=Could+not+check+your+account.",
    );
  });

  test("a successful sign-in still goes to the role's page, not login", async () => {
    const window = loadCallbackPage(
      fakeSupabase({
        sessionResult: {
          data: { session: { access_token: "tok", user: { id: "u1" } } },
          error: null,
        },
        profileResult: {
          data: { id: "u1", name: "Test Tutor", role: "tutor" },
          error: null,
        },
      }),
    );
    await settle();

    expect(window.__redirectedTo).toBe("/html/dashboard.html");
  });
});

describe("login.html picks up the failure", () => {
  test("shows the authError message and drops the param", () => {
    const window = loadLoginPage(
      "?authError=Could+not+complete+Google+sign-in.",
    );

    const message = window.document.getElementById("login-message");
    expect(message.textContent).toBe("Could not complete Google sign-in.");
    expect(message.classList.contains("is-error")).toBe(true);
    expect(window.location.search).toBe("");
  });

  test("keeps other query params when dropping authError", () => {
    const window = loadLoginPage("?authError=Denied.&tab=hours");

    expect(window.document.getElementById("login-message").textContent).toBe(
      "Denied.",
    );
    expect(window.location.search).toBe("?tab=hours");
  });

  test("leaves the message area alone without an authError param", () => {
    const window = loadLoginPage();

    expect(window.document.getElementById("login-message").textContent).toBe(
      "",
    );
    expect(window.location.search).toBe("");
  });
});
