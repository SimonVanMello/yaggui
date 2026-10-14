import { defineConfig, devices } from '@playwright/test';

// Lets environments with a preinstalled Chromium (e.g. CI containers) skip `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  // Measurements run on a production build (`pnpm perf:*`, playwright.perf.config.ts); README
  // screenshots have their own config (`pnpm screenshots`).
  testIgnore: ['perf*.spec.ts', 'readme-screenshots.spec.ts'],
  outputDir: './test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1430',
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1430',
    // Port 1430 is only used by the mock server (see vite.config.ts), so reuse is safe.
    reuseExistingServer: !process.env.CI,
  },
});
