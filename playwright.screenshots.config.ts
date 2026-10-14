import { defineConfig, devices } from '@playwright/test';

/** README screenshots (`pnpm screenshots`): e2e/readme-screenshots.spec.ts → docs/assets/. */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'readme-screenshots.spec.ts',
  outputDir: './test-results/screenshots',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1430',
    locale: 'en-US',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1430',
    reuseExistingServer: !process.env.CI,
  },
});
