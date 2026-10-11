// One-shot: dump the text runs of a small hand-built PDF (uncompressed
// content streams) in stream order, for eyeballing generated transcripts.
//   node dump-pdf-text.js <file.pdf>
const fs = require("fs");
const pdf = fs.readFileSync(
  process.argv[2] || "generated-transcripts/Oupa_Sir.pdf",
  "latin1",
);
const runs = [...pdf.matchAll(/\((?:\\.|[^()\\])*\)\s*Tj/g)].map((m) =>
  m[0].slice(1, m[0].lastIndexOf(")")).replace(/\\([()\\])/g, "$1"),
);
console.log(runs.join("\n"));
