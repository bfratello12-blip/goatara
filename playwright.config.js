const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  workers: 1,
  timeout: 30000,
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile Safari", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
});
