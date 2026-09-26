// Shared by dashboard.js and studentview.js: a notification click lands here
// via a `?highlightCourse=<id>` query param, and once the page's own render
// logic has built the matching row, these two helpers scroll it into view
// and flash it briefly so it's obvious which one the notification meant.

// Reads and removes the param from the URL (via replaceState, no reload) so
// refreshing the page afterward doesn't re-trigger the highlight forever.
export function consumeQueryParam(paramName) {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(paramName);
  if (value == null) return null;

  params.delete(paramName);
  const query = params.toString();
  history.replaceState(
    null,
    "",
    window.location.pathname + (query ? `?${query}` : ""),
  );
  return value;
}

export function scrollAndHighlight(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("highlight-flash");
  setTimeout(() => el.classList.remove("highlight-flash"), 2500);
}
