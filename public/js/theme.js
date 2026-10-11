(() => {
  const storageKey = "tms-theme";
  const root = document.documentElement;
  const buttons = [];

  // Sun/moon icons, swapped per state: a sun while in dark mode (click
  // goes to light) and a moon while in light mode. The button matches the
  // navbar's other circular icon buttons, so the icon itself carries the
  // state — aria-label/title say the same thing for screen readers.
  const SUN_ICON = `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </svg>`;
  const MOON_ICON = `<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>`;

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
      button.innerHTML = isDark ? SUN_ICON : MOON_ICON;
      const label = isDark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-pressed", String(isDark));
      button.setAttribute("aria-label", label);
      button.title = label;
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
