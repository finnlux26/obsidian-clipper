// Validates the shipped providers.json presets (fork issue #8): the
// "Local proxy (OpenAI-compatible)" preset must exist so a Codex-subscription
// proxy or another local OpenAI-compatible server can be added with one click
// and no API key.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PresetProvider } from './interpreter-settings';

// Vitest runs from the repo root (vitest.config.ts lives there)
const providersPath = resolve(process.cwd(), 'providers.json');
const presets = JSON.parse(readFileSync(providersPath, 'utf8')) as Record<string, PresetProvider | string>;

describe('providers.json presets', () => {
	test('every preset entry carries a matching id', () => {
		for (const [key, preset] of Object.entries(presets)) {
			if (key === 'version') continue;
			expect((preset as PresetProvider).id).toBe(key);
		}
	});

	test('ships a keyless local proxy preset pointing at a localhost endpoint', () => {
		const preset = presets['local-proxy'] as PresetProvider;
		expect(preset).toBeDefined();
		expect(preset.name).toBe('Local proxy (OpenAI-compatible)');
		expect(preset.apiKeyRequired).toBe(false);
		expect(preset.baseUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?\//);
		// No key to get, nothing to link to
		expect(preset.apiKeyUrl).toBeUndefined();
	});
});
