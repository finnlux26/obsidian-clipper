import { defineConfig } from '@playwright/test';

// E2E suite for the extension (fork issue #4). Requires a Chrome build in
// dist/ — run `npm run test:e2e`, which chains `npm run build:chrome` first.
export default defineConfig({
	testDir: './e2e',
	// Each test launches its own persistent context with the extension
	// loaded; keep them sequential for deterministic request logs.
	workers: 1,
	fullyParallel: false,
	retries: 1,
	forbidOnly: !!process.env.CI,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
	timeout: 60000,
	use: {
		trace: 'on-first-retry'
	}
});
