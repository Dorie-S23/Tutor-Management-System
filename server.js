require("dotenv").config();

const express = require("express");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Static frontend (Cloudflare Workers serves this via its assets layer instead,
// with its own edge caching — this only affects local dev/`node server.js`).
// HTML pages get Cache-Control: no-store — a browser must never reuse a
// cached copy of a page, full stop, since that's exactly what made an edit
// look like it hadn't landed even after a plain reload. JS/CSS/images still
// get etag-based revalidation (a cheap 304 when unchanged) rather than
// no-store, since those aren't what broke.
app.use(
  express.static("public", {
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
