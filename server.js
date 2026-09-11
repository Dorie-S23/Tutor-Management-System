require("dotenv").config();

const express = require("express");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Static frontend (Cloudflare Workers serves this via its assets layer instead,
// with its own edge caching — this maxAge only helps local dev/`node server.js`)
app.use(express.static("public", { maxAge: "1d", etag: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
