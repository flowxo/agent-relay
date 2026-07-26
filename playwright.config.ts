import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/relay/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] === undefined ? 0 : 1,
  reporter: "line",
  outputDir: ".artifacts/playwright",
  expect: {
    timeout: 10_000,
  },
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});
