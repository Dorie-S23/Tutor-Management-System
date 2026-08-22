// Highlights the nav tab matching the current page.
// Compares basenames with the .html extension stripped, so this still works
// whether the server exposes clean URLs (e.g. /log-hours) or plain static
// files (e.g. /log-hours.html).
function normalize(path) {
  const basename = path.split('/').pop() || 'dashboard';
  return basename.replace(/\.html$/, '') || 'dashboard';
}

export function highlightActiveTab() {
  const currentPage = normalize(window.location.pathname);
  document.querySelectorAll('.tab-nav a').forEach((link) => {
    const linkPage = normalize(link.getAttribute('href'));
    link.classList.toggle('active', linkPage === currentPage);
  });
}
