import "./e2e/env";
import { defineConfig } from "@playwright/test";

const frontendPort = process.env.FRONTEND_PORT || "3000";
const expandFrontendPort = (url?: string) =>
  url?.replaceAll("${FRONTEND_PORT}", frontendPort);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60000,
  workers: 1,
  retries: 0,
  use: {
    baseURL:
      expandFrontendPort(process.env.PLAYWRIGHT_BASE_URL) ||
      expandFrontendPort(process.env.FRONTEND_ORIGIN) ||
      `http://localhost:${frontendPort}`,
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Don't auto-start servers — they must be running already
  // This avoids complexity and port conflicts during testing
});
