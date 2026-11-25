// Generates shields-style flat SVG coverage badges from jest's
// coverage/coverage-summary.json — one per coverage target, so the README
// can show the server API and the client UI separately. Self-hosted on the
// repo's `badges` branch (see .github/workflows/test.yml), same as the
// overall badge — no third-party coverage service involved.
//
// Usage: node scripts/coverage-badges.js  (after `jest --coverage`)

const fs = require("fs");
const path = require("path");

const summaryPath = path.join(
  __dirname,
  "..",
  "coverage",
  "coverage-summary.json",
);
const outDir = path.join(__dirname, "..", "coverage");

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

// A coverage target is a path filter over the per-file entries jest emits.
// Windows checkouts emit backslash paths in the summary — normalize so the
// filters read the same on a dev machine and in the linux CI runner.
const normalize = (filePath) => filePath.replace(/\\/g, "/");

const TARGETS = [
  {
    key: "server-api",
    label: "server api",
    matches: (filePath) => filePath.includes("/server/"),
  },
  {
    key: "client-ui",
    label: "client ui",
    matches: (filePath) => filePath.includes("/public/js/"),
  },
];

// Codecov-like colouring: red while shaky, amber when decent, green when solid.
function colorFor(pct) {
  if (pct >= 90) return "#4c1";
  if (pct >= 75) return "#a4a61d";
  if (pct >= 60) return "#dfb317";
  return "#e05d44";
}

// Statements are the headline metric the overall badge already uses.
function statementsPct(files) {
  let hit = 0;
  let total = 0;
  for (const file of files) {
    hit += file.statements.covered;
    total += file.statements.total;
  }
  return total === 0 ? 0 : (hit / total) * 100;
}

// Flat shields.io-style badge: rounded pill, label half grey, value half
// coloured. Text widths are measured generously for the 11px sans font the
// SVG specifies, so nothing clips across browsers.
function badgeSvg(label, valueText, color) {
  const labelWidth = label.length * 6.5 + 12;
  const valueWidth = valueText.length * 7 + 12;
  const width = labelWidth + valueWidth;
  const mid = labelWidth + 0.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${valueText}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${width}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${mid + (width - mid) / 2}" y="14" font-weight="bold">${valueText}</text>
  </g>
</svg>
`;
}

fs.mkdirSync(outDir, { recursive: true });

for (const target of TARGETS) {
  const files = Object.entries(summary)
    .filter(([filePath, entry]) => {
      // "total" is a summary-wide entry, not a file — skip it.
      return (
        filePath !== "total" &&
        entry.statements &&
        target.matches(normalize(filePath))
      );
    })
    .map(([, entry]) => entry);
  const pct = statementsPct(files);
  const valueText = `${Math.round(pct * 100) / 100}%`;
  const svg = badgeSvg(target.label, valueText, colorFor(pct));
  const outPath = path.join(outDir, `${target.key}.svg`);
  fs.writeFileSync(outPath, svg);
  console.log(`coverage badge: ${target.key} = ${valueText} -> ${outPath}`);
}
