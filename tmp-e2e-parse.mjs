// Throwaway: build a minimal valid one-page PDF with a text timetable row,
// then post it to the local parse route for an end-to-end model check.
import fs from "node:fs";

const lines = [
  "COMS3011A Software Design Project III",
  "Monday 10:15 - 12:00 MSL004",
  "HON1001F Tutorial",
  "Wednesday 14:00 - 15:45 PLM001",
];

let content = "BT /F1 11 Tf 40 760 Td 16 TL\n";
lines.forEach((l, i) => {
  const escaped = l.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  content += `${i === 0 ? "" : "T* "}${i > 0 ? `(${escaped}) Tj\n` : `(${escaped}) Tj\n`}`;
});
content += "ET\n";

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

fs.writeFileSync("tmp-timetable-check.pdf", Buffer.from(pdf, "binary"));
console.log("wrote tmp-timetable-check.pdf", pdf.length, "bytes");

const res = await fetch("http://localhost:3100/api/timetable/parse", {
  method: "POST",
  headers: { "Content-Type": "application/pdf" },
  body: fs.readFileSync("tmp-timetable-check.pdf"),
});
const body = await res.text();
console.log(`parse route: HTTP ${res.status}`);
console.log(body.slice(0, 1200));

