require("dotenv").config();

const express = require("express");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Static frontend (Cloudflare Workers serves this via its assets layer instead,
// with its own edge caching — this only affects local dev/`node server.js`).
// maxAge: 0 with etag still lets the browser skip re-downloading an unchanged
// file (a cheap 304 on the conditional request), but it can no longer serve a
// stale HTML/JS file straight from cache without asking the server first —
// a full day's max-age here meant an edit could go completely unnoticed in
// the browser until a hard refresh.
app.use(express.static("public", { maxAge: 0, etag: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
