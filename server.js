require("dotenv").config();

const express = require("express");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Static frontend (Cloudflare Workers serves this via its assets layer instead,
// with its own edge caching). Locally the browser should always revalidate —
// the old day-long max-age made edited pages/JS show up stale for hours.
app.use(express.static("public", { etag: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
