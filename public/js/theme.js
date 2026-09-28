(() => {
  const storageKey = "tms-theme";
  const root = document.documentElement;
  const buttons = [];

  function getStoredTheme() {
    try {
      const theme = window.localStorage.getItem(storageKey);
      return theme === "dark" || theme === "light" ? theme : null;
    } catch {
      return null;
    }
  }

  function getSystemTheme() {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme, persist = false) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;

    if (persist) {
      try {
        window.localStorage.setItem(storageKey, theme);
      } catch {
        // Ignore unavailable browser storage.
      }
    }

    buttons.forEach((button) => {
      const isDark = theme === "dark";
      button.textContent = isDark ? "Light mode" : "Dark mode";
      button.setAttribute("aria-pressed", String(isDark));
      button.setAttribute(
        "aria-label",
        isDark ? "Switch to light mode" : "Switch to dark mode",
      );
    });
  }

  function mountToggle() {
    // Prefer the redesigned pages' dedicated slot; the legacy selectors
    // keep the older pages mounting where they always have. .auth-shell
    // covers the split-screen auth pages (CSS pins the toggle top-right).
    const target = [
      ".navbar-right",
      ".header-actions",
      ".tab-nav",
      ".header-right",
      ".auth-header",
      ".auth-shell",
    ]
      .map((selector) => document.querySelector(selector))
      .find(Boolean);

    if (!target) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.addEventListener("click", () => {
      applyTheme(root.dataset.theme === "dark" ? "light" : "dark", true);
    });

    buttons.push(button);
    target.append(button);
    applyTheme(root.dataset.theme);
  }

  applyTheme(getStoredTheme() ?? getSystemTheme());

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountToggle, { once: true });
  } else {
    mountToggle();
  }
})();
