// E2E: context-aware word translation in reader mode (fork issues #3/#4).
//
// Each test gets a fresh persistent context (own user-data-dir) and a fresh
// mock server on an ephemeral port, so request counts and storage state never
// bleed between tests.
//
// LLM traffic is asserted through the mock server's /__requests log, not
// through Playwright routing: the translation fetch is proxied through the
// extension service worker (action: 'fetchProxy'), and service-worker fetches
// bypass page-level route interception entirely.
import { expect, test } from '@playwright/test';
import { Page } from '@playwright/test';
import {
	ExtensionHarness,
	doubleClickWord,
	launchExtension,
	seedInterpreterSettings,
	toggleReader
} from './helpers/extension';
import { CANNED_TRANSLATION, MockServer, startMockServer } from './server';

// The sentence in article.html that contains the test word "bank" — the
// interpreter request must carry it as context (word-level polysemy).
const CONTAINING_SENTENCE = 'She sat on the river bank and watched the barges drift past.';

const TRANSLATE_BUTTON = '.obsidian-selection-translate';
const POPOVER = '.obsidian-translate-popover';

let server: MockServer;
let harness: ExtensionHarness;

test.beforeEach(async ({}, testInfo) => {
	server = await startMockServer();
	harness = await launchExtension(testInfo.outputPath('user-data'));
});

test.afterEach(async () => {
	await harness.context.close();
	await server.close();
});

async function openArticleInReader(chatBaseUrl?: string): Promise<Page> {
	if (chatBaseUrl !== undefined) {
		await seedInterpreterSettings(harness.serviceWorker, {
			interpreterEnabled: true,
			baseUrl: chatBaseUrl
		});
	}
	const page = await harness.context.newPage();
	const articleUrl = `${server.baseUrl}/pages/article.html`;
	await page.goto(articleUrl, { waitUntil: 'load' });
	await toggleReader(harness.serviceWorker, articleUrl);
	// .first(): defuddle keeps the fixture's own <article> nested inside the
	// reader's <article> wrapper, so the selector matches twice.
	await expect(page.locator('.obsidian-reader-content article').first()).toBeVisible();
	return page;
}

async function translateWord(page: Page, word: string) {
	await doubleClickWord(page, word);
	const button = page.locator(TRANSLATE_BUTTON);
	await expect(button).toBeVisible();
	await button.click();
	return page.locator(POPOVER);
}

test.describe('word translation popover', () => {
	test('translates a double-clicked word and sends the containing sentence for context', async () => {
		const page = await openArticleInReader(`${server.baseUrl}/v1/chat/completions`);

		const popover = await translateWord(page, 'bank');
		await expect(popover).toHaveAttribute('data-state', 'done', { timeout: 15000 });
		await expect(popover.locator('.obsidian-translate-word')).toHaveText('bank');
		await expect(popover.locator('.obsidian-translate-result')).toHaveText(
			CANNED_TRANSLATION.translation
		);
		await expect(popover.locator('.obsidian-translate-meaning')).toHaveText(
			CANNED_TRANSLATION.meaningInContext
		);

		const requests = await server.requests();
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe('POST');
		const body = JSON.parse(requests[0].body);
		expect(Array.isArray(body.messages)).toBe(true);
		const userContent = body.messages
			.map((message: { content: string }) => message.content)
			.join('\n');
		expect(userContent).toContain(CONTAINING_SENTENCE);
		expect(userContent).toContain('"selection":"bank"');

		expect(harness.leakedRequests).toEqual([]);
	});

	test('re-selecting the same word is served from the cache without a new request', async () => {
		const page = await openArticleInReader(`${server.baseUrl}/v1/chat/completions`);

		const popover = await translateWord(page, 'bank');
		await expect(popover).toHaveAttribute('data-state', 'done', { timeout: 15000 });
		expect(await server.requests()).toHaveLength(1);

		// Dismiss the popover, then run the whole gesture again
		await page.keyboard.press('Escape');
		await expect(popover).toHaveCount(0);

		const popoverAgain = await translateWord(page, 'bank');
		await expect(popoverAgain).toHaveAttribute('data-state', 'done', { timeout: 15000 });
		await expect(popoverAgain.locator('.obsidian-translate-result')).toHaveText(
			CANNED_TRANSLATION.translation
		);

		// Cache hit: the request count must not have grown
		expect(await server.requests()).toHaveLength(1);
		expect(harness.leakedRequests).toEqual([]);
	});

	test('shows an error state when the LLM endpoint returns 500', async () => {
		const page = await openArticleInReader(`${server.baseUrl}/v1/chat/completions?fail=500`);

		const popover = await translateWord(page, 'bank');
		await expect(popover).toHaveAttribute('data-state', 'error', { timeout: 15000 });
		// src/_locales/en/messages.json → translationFailed
		await expect(popover.locator('.obsidian-translate-body')).toHaveText(
			'Translation failed. Please try again.'
		);

		expect(await server.requests()).toHaveLength(1);
		expect(harness.leakedRequests).toEqual([]);
	});

	test('shows the configure-interpreter message when no interpreter is set up', async () => {
		// No interpreter settings seeded at all — fresh profile defaults
		const page = await openArticleInReader(undefined);

		const popover = await translateWord(page, 'bank');
		await expect(popover).toHaveAttribute('data-state', 'error', { timeout: 15000 });
		// src/_locales/en/messages.json → translationNoEngine
		await expect(popover.locator('.obsidian-translate-body')).toHaveText(
			'Set up an Interpreter model in settings to enable translation.'
		);

		// No request may reach the LLM endpoint when nothing is configured
		expect(await server.requests()).toEqual([]);
		expect(harness.leakedRequests).toEqual([]);
	});
});
