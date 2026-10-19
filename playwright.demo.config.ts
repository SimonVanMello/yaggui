import { defineConfig, devices } from '@playwright/test';

/**
 * The live demo as the website serves it (`pnpm test:demo`): e2e/demo.spec.ts on the built site.
 * Build it first: `cd website && pnpm build`. Served with Vite's preview (the Astro one daemonizes).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'demo.spec.ts',
  outputDir: './test-results/demo',
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4321',
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
    command: 'pnpm exec vite preview --outDir website/dist --port 4321 --strictPort',
    url: 'http://localhost:4321',
    reuseExistingServer: !process.env.CI,
  },
});
