// One-shot: extract the text runs from a PDF's content streams. Handles
// plain and Flate-compressed streams, including the ASCII85 layer reportlab
// wraps them in (which is how Sample_Transcript_Arti_Nouh.pdf is encoded).
//   node extract-transcript-text.js <file.pdf>
const fs = require("fs");
const zlib = require("zlib");

function ascii85Decode(str) {
  str = str.replace(/\s/g, "").replace(/~>$/, "");
  const out = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "z") {
      out.push(0, 0, 0, 0);
      i++;
      continue;
    }
    const chunk = str.substr(i, 5);
    const n = chunk.length;
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const c = k < n ? chunk.charCodeAt(k) - 33 : 84;
      v = v * 85 + c;
    }
    out.push(
      ...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(
        0,
        n - 1,
      ),
    );
    i += 5;
  }
  return Buffer.from(out);
}

const pdf = fs.readFileSync(process.argv[2], "latin1");
const streams = [...pdf.matchAll(/stream\r?\n([\s\S]*?)endstream/g)];
const runs = [];
for (const m of streams) {
  let data = Buffer.from(m[1], "latin1");
  try {
    data = zlib.inflateSync(data);
  } catch {
    try {
      data = zlib.inflateSync(ascii85Decode(m[1]));
    } catch {
      // not compressed — use the raw bytes
    }
  }
  const text = data.toString("latin1");
  for (const t of text.matchAll(/\((?:\\.|[^()\\])*\)\s*Tj/g)) {
    runs.push(
      t[0].slice(1, t[0].lastIndexOf(")")).replace(/\\([()\\])/g, "$1"),
    );
  }
}
console.log(runs.join("\n"));
