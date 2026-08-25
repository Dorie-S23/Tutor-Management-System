require("dotenv").config();

const express = require("express");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Static frontend (Cloudflare Workers serves this via its assets layer instead)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
