// The volunteer dark-mode readability fixes in app.css are scoped to
// body[data-theme="volunteer"] so they can't leak into the tutor or
// organiser shells. That attribute is purely a scoping hook — no palette
// rules attach to it (volunteers keep the default blue accent) — so these
// tests pin the contract rather than the colors: every volunteer page
// carries the hook, no other page does, and the scoped fixes exist.
const fs = require("fs");
const path = require("path");

const htmlDir = path.join(__dirname, "..", "html");
const appCssPath = path.join(__dirname, "..", "css", "app.css");

const VOLUNTEER_PAGES = [
  "StudentView.html",
  "my-sessions.html",
  "student-profile.html",
  "student-calendar.html",
  "volunteer-log-hours.html",
  "volunteer-timesheets.html",
];

function pageHtml(name) {
  return fs.readFileSync(path.join(htmlDir, name), "utf8");
}

describe("volunteer dark-mode scoping", () => {
  test.each(VOLUNTEER_PAGES)(
    "%s carries the body[data-theme=volunteer] hook",
    (page) => {
      expect(pageHtml(page)).toMatch(/<body[^>]*data-theme="volunteer"/);
    },
  );

  test("no non-volunteer page carries the volunteer hook", () => {
    const offenders = fs
      .readdirSync(htmlDir)
      .filter((f) => f.endsWith(".html") && !VOLUNTEER_PAGES.includes(f))
      .filter((f) => /<body[^>]*data-theme="volunteer"/.test(pageHtml(f)));
    expect(offenders).toEqual([]);
  });

  // Each of these rendered as near-invisible --blue-dark / --blue text on
  // the dark page before the scoped block existed; the bounded windows
  // below tolerate prettier re-flowing the selector lists.
  test("the scoped dark-mode fixes exist for every volunteer component", () => {
    const css = fs.readFileSync(appCssPath, "utf8");
    const fixedClasses = [
      ".session-cover-badge",
      ".status-pill.submitted",
      ".course-chip__code",
      ".session-chip__note",
      ".calendar-class-pill",
      ".day-view-event--class",
      ".session-code",
      ".tab-nav",
    ];
    for (const cls of fixedClasses) {
      expect(css).toMatch(
        new RegExp(
          `html\\[data-theme="dark"\\][\\s\\S]{0,120}` +
            `body\\[data-theme="volunteer"\\][\\s\\S]{0,260}` +
            cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
        `expected a dark-mode fix scoped to volunteers for ${cls}`,
      );
    }
  });
});
