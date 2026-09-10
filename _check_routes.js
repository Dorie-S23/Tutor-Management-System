/**
 * Diagnostic: print the Express route stack for /api/tutors to check ordering.
 */
require("dotenv").config();
const app = require("./app");

// Find the /api/tutors router layer and print its sub-routes
app._router.stack.forEach((layer) => {
  if (layer.regexp && layer.regexp.test("/api/tutors/workload")) {
    if (layer.handle && layer.handle.stack) {
      console.log(`\nRouter at ${layer.regexp}  (${layer.handle.stack.length} routes):`);
      layer.handle.stack.forEach((sub, i) => {
        const method = sub.route
          ? Object.keys(sub.route.methods).join(",").toUpperCase()
          : "MW";
        const path = sub.route ? sub.route.path : (sub.regexp ? sub.regexp.toString() : "?");
        console.log(`  ${i}: ${method} ${path}`);
      });
    }
  }
});
