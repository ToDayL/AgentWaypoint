import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  testMatch: /\.pw\.ts$/,
  workers: 1,
  timeout: 60_000,
  use: { headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
});
