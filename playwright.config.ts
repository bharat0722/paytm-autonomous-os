import { defineConfig } from "@playwright/test"

// Combined browser checks (Owner 03 writes specs in tests/acceptance).
// Requires `npx playwright install chromium` once per machine.
export default defineConfig({
  testDir: "tests/acceptance",
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173" }
})
