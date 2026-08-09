// Extension launch and driving helpers for the E2E suite (fork issue #4).
//
// The extension is loaded unpacked from dist/ into a persistent context.
// Modern Playwright supports MV3 extensions in headless mode when using the
// bundled full Chromium via `channel: 'chromium'` (the headless shell does
// not support extensions).
import * as path from 'node:path';
import { BrowserContext, Page, Worker, chromium } from '@playwright/test';

const EXTENSION_PATH = path.resolve(__dirname, '..', '..', 'dist');

export interface ExtensionHarness {
	context: BrowserContext;
	serviceWorker: Worker;
	extensionId: string;
	// URLs of requests that the localhost-only guard aborted. Tests assert
	// this stays empty: any attempt to leave localhost is a failure.
	leakedRequests: string[];
}

function isAllowedUrl(url: string): boolean {
	if (
		url.startsWith('chrome-extension://') ||
		url.startsWith('chrome://') ||
		url.startsWith('about:') ||
		url.startsWith('data:') ||
		url.startsWith('blob:')
	) {
		return true;
	}
	try {
		const { hostname } = new URL(url);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
	} catch {
		return false;
	}
}

export async function launchExtension(userDataDir: string): Promise<ExtensionHarness> {
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		headless: true,
		args: [
			`--disable-extensions-except=${EXTENSION_PATH}`,
			`--load-extension=${EXTENSION_PATH}`
		]
	});

	// Route-block everything that is not localhost or extension-internal so
	// no test can leak to the real network. Note: this only covers requests
	// issued by pages — the extension service worker's fetches bypass page
	// routing, which is why LLM traffic is asserted via the mock server's
	// /__requests log instead.
	const leakedRequests: string[] = [];
	await context.route('**/*', route => {
		const url = route.request().url();
		if (isAllowedUrl(url)) {
			return route.continue();
		}
		leakedRequests.push(url);
		return route.abort('blockedbyclient');
	});

	const serviceWorker =
		context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	const extensionId = new URL(serviceWorker.url()).host;

	return { context, serviceWorker, extensionId, leakedRequests };
}

// Settings shapes mirror src/utils/storage-utils.ts (StorageData) — settings
// are persisted in chrome.storage.sync under the `interpreter_settings` key
// and read back by loadSettings() in the extension.
export interface InterpreterSeed {
	interpreterEnabled: boolean;
	baseUrl: string;
	providerName?: string;
	apiKey?: string;
	modelId?: string;
	providerModelId?: string;
}

export async function seedInterpreterSettings(
	serviceWorker: Worker,
	seed: InterpreterSeed
): Promise<void> {
	const providerId = 'e2e-provider';
	const modelId = seed.modelId ?? 'e2e-model';
	const interpreterSettings = {
		interpreterModel: modelId,
		models: [
			{
				id: modelId,
				providerId,
				providerModelId: seed.providerModelId ?? 'mock-model',
				name: 'E2E Mock Model',
				enabled: true
			}
		],
		providers: [
			{
				id: providerId,
				// Must not contain provider-specific trigger substrings
				// (anthropic, ollama, …) so llm-request.ts takes the default
				// OpenAI-compatible request shape.
				name: seed.providerName ?? 'E2E Mock OpenAI',
				baseUrl: seed.baseUrl,
				apiKey: seed.apiKey ?? 'e2e-test-key',
				apiKeyRequired: false
			}
		],
		interpreterEnabled: seed.interpreterEnabled,
		interpreterAutoRun: false,
		defaultPromptContext: ''
	};

	await serviceWorker.evaluate(async settings => {
		await chrome.storage.sync.set({ interpreter_settings: settings });
	}, interpreterSettings);
}

// Drive reader mode exactly the way the keyboard command handler does
// (src/background.ts, commands.onCommand "toggle_reader"): inject the reader
// CSS + scripts via chrome.scripting, then send { action: "toggleReaderMode" }
// to the tab. The content script (content.js) is auto-injected by the
// manifest on http(s) pages, so only the reader script needs injecting here.
export async function toggleReader(serviceWorker: Worker, pageUrl: string): Promise<void> {
	const result = await serviceWorker.evaluate(async url => {
		// tabs.query({ url }) takes match patterns, which cannot express a
		// port — filter on the exact URL instead (the mock server binds an
		// ephemeral port).
		const tabs = await chrome.tabs.query({});
		const tabId = tabs.find(tab => tab.url === url)?.id;
		if (!tabId) {
			return { success: false, error: `No tab found for ${url}` };
		}
		await chrome.scripting.insertCSS({ target: { tabId }, files: ['reader.css'] });
		await chrome.scripting
			.insertCSS({ target: { tabId }, files: ['highlighter.css'] })
			.catch(() => {});
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js']
		});
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js']
		});
		const response = (await chrome.tabs.sendMessage(tabId, {
			action: 'toggleReaderMode'
		})) as { success?: boolean; error?: string } | undefined;
		return { success: response?.success === true, error: response?.error };
	}, pageUrl);

	if (!result.success) {
		throw new Error(`toggleReaderMode failed: ${result.error ?? 'no response'}`);
	}
}

// Select a single word with a real double-click: find the first text node in
// the reader article containing the word, scroll it into view, then
// double-click the mouse at the centre of the word's bounding box.
export async function doubleClickWord(page: Page, word: string): Promise<void> {
	const point = await page.evaluate(target => {
		const article = document.querySelector('.obsidian-reader-content article');
		if (!article) return null;
		const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
		const wordPattern = new RegExp(`\\b${target}\\b`);
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const match = wordPattern.exec(node.textContent || '');
			if (!match) continue;
			node.parentElement?.scrollIntoView({ block: 'center' });
			const range = document.createRange();
			range.setStart(node, match.index);
			range.setEnd(node, match.index + target.length);
			const rect = range.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		}
		return null;
	}, word);

	if (!point) {
		throw new Error(`Word "${word}" not found in reader article`);
	}
	await page.mouse.dblclick(point.x, point.y);
}
