import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The build config (`vite.config.ts`) is the production bundler entry —
    // it dynamically calls `glob()` at import time which is unnecessary for
    // unit tests and slows them down. Keep this config minimal.
  },
});
