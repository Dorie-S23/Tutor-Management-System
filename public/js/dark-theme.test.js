// Static guards for the site-wide dark/light theme. The toggle's behaviour
// itself is covered in page-helpers.test.js (theme.js section); this suite
// keeps a redesigned page or new stylesheet from silently shipping without
// dark rules again: every page must load the shared theme script, and every
// stylesheet a page loads must ship a html[data-theme="dark"] layer.
const fs = require("fs");
const path = require("path");

const htmlDir = path.join(__dirname, "..", "html");
const cssDir = path.join(__dirname, "..", "css");

const pages = fs
  .readdirSync(htmlDir)
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({
    name,
    markup: fs.readFileSync(path.join(htmlDir, name), "utf8"),
  }));

describe("dark theme coverage", () => {
  test("every page loads the shared theme script", () => {
    const missing = pages
      .filter(
        ({ markup }) =>
          !/<script[^>]*src="[^"]*theme\.js"[^>]*><\/script>/.test(markup),
      )
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });

  test("every stylesheet a page loads ships dark rules", () => {
    const linked = new Set();
    for (const { markup } of pages) {
      for (const match of markup.matchAll(
        /rel="stylesheet" href="(?:\.\.\/|\/)+css\/([\w-]+\.css)"/g,
      )) {
        linked.add(match[1]);
      }
    }

    expect(linked.size).toBeGreaterThan(0);
    const bare = [...linked].filter((file) => {
      const css = fs.readFileSync(path.join(cssDir, file), "utf8");
      return !css.includes('html[data-theme="dark"]');
    });
    expect(bare).toEqual([]);
  });

  test("the redesigned sheet swaps its surfaces and keeps print on white paper", () => {
    const appCss = fs.readFileSync(path.join(cssDir, "app.css"), "utf8");

    // The dark token layer is declared on html[data-theme="dark"] body so
    // its specificity (0,1,2) beats the per-role accent blocks (0,1,1) — one
    // dark theme serves every role regardless of source order.
    expect(appCss).toMatch(/html\[data-theme="dark"\]\s+body\s*\{[^}]*--page:/);
    expect(appCss).toMatch(
      /html\[data-theme="dark"\]\s+body\s*\{[^}]*--surface:/,
    );

    // The toggle the script injects is styled here because the redesigned
    // pages do not load global.css — grouped with the navbar icon buttons.
    expect(appCss).toContain(".theme-toggle");

    // Dark mode must not bleed onto paper.
    expect(appCss).toContain("@media print");
    expect(appCss).toContain('html[data-theme="dark"] .claim-form');
  });

  test("the toggle mount prefers the redesigned navbar slot", () => {
    const themeJs = fs.readFileSync(path.join(__dirname, "theme.js"), "utf8");
    const navbarRight = themeJs.indexOf('".navbar-right"');
    expect(navbarRight).toBeGreaterThan(-1);
    expect(navbarRight).toBeLessThan(themeJs.indexOf('".header-actions"'));

    // The password-auth pages only have an .auth-shell to host the toggle.
    expect(themeJs).toContain('".auth-shell"');
  });
});
