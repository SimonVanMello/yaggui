import { defineConfig, devices } from '@playwright/test';

/**
 * Docs screenshots (`pnpm screenshots:docs`): e2e/docs-screenshots/*.spec.ts on the mock backend,
 * written to website/src/assets/screens/<name>-dark.png and -light.png. Not part of `pnpm test:ui`.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e/docs-screenshots',
  outputDir: './test-results/docs-screenshots',
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:1430',
    locale: 'en-US',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'dark',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        colorScheme: 'dark',
      },
    },
    {
      name: 'light',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        colorScheme: 'light',
      },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1430',
    reuseExistingServer: !process.env.CI,
  },
});
