// Temp probe: POST the synthetic timetable PDF to production only (no direct
// Gemini call, to conserve the free-tier per-minute quota).
const PROD = "https://tutorx.devden.workers.dev";

function buildTimetablePdf() {
  const rows = [
    "Monday COMS3011A Software Design Project III 09:00-10:30 MSL004",
    "Monday COMS3011A Software Design Project III 10:30-12:00 MSL004",
    "Tuesday MATH2001A Advanced Calculus 14:00-15:30 CLM100",
    "Thursday COMS3022A Operating Systems 08:00-09:00 LCT201",
  ];
  let content = "BT /F1 11 Tf 40 740 Td 18 TL\n";
  for (const row of rows) {
    content += `(${row.replace(/[\\()]/g, "\\$&")}) Tj T*\n`;
  }
  content += "ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

(async () => {
  const res = await fetch(`${PROD}/api/timetable/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: buildTimetablePdf(),
  });
  const body = await res.text();
  console.log(`production /api/timetable/parse: HTTP ${res.status}`);
  console.log(body.slice(0, 900));
})().catch((err) => {
  console.log("probe failed:", err.message);
  process.exit(1);
});
