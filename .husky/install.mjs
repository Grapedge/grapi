import { existsSync } from "node:fs";

// Skip when installing from npm tarball or a non-git source.
if (!existsSync(".git")) {
  process.exit(0);
}

// Skip in explicit production or CI environments.
if (process.env.NODE_ENV === "production" || process.env.CI === "true") {
  process.exit(0);
}

// Silently skip if husky is not installed (e.g. `npm install --omit=dev`).
try {
  const { default: husky } = await import("husky");
  console.log(husky());
} catch {
  // husky is not available
}
