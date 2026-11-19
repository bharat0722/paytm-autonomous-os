import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/core/**/*.test.ts", "tests/workflow/**/*.test.ts", "apps/web/**/*.test.{ts,tsx}"],
    exclude: ["tests/acceptance/**", "node_modules/**"],
    testTimeout: 20000,
    pool: "forks"
  }
})
