// @vitest-environment jsdom
// Full-article bilingual mode (fork issue #9): viewport-lazy translation of
// article blocks, batched LLM requests with a session glossary, paragraph
// cache, per-URL memory, full restore on toggle-off. Network mocked at the
// fetchProxy seam; IntersectionObserver replaced with a manual trigger.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import browser from './browser-polyfill';
import {
	enableFullTranslation,
	disableFullTranslation,
	isFullTranslationActive,
	clearFullTranslationCache,
	wasFullTranslationEnabled,
	rememberFullTranslation
} from './reader-full-translation';
import { clearTranslationCache } from './translator';
import { generalSettings } from './storage-utils';

class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	observed: Element[] = [];
	constructor(public cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void, public options?: unknown) {
		FakeIntersectionObserver.instances.push(this);
	}
	observe(el: Element) { this.observed.push(el); }
	unobserve(el: Element) { this.observed = this.observed.filter(e => e !== el); }
	disconnect() { this.observed = []; }
	trigger(els: Element[]) {
		this.cb(els.map(target => ({ target, isIntersecting: true })));
	}
}

function io(): FakeIntersectionObserver {
	return FakeIntersectionObserver.instances[FakeIntersectionObserver.instances.length - 1];
}

async function settle(times = 6) {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

const OPTS = {
	targetLanguage: 'zh',
	article: { title: 'How Banks Work', site: 'example.com', lang: 'en' },
	url: 'https://example.com/banks'
};

function configureLlm() {
	generalSettings.interpreterEnabled = true;
	generalSettings.interpreterModel = 'model-1';
	generalSettings.models = [
		{ id: 'model-1', providerId: 'provider-1', providerModelId: 'claude-haiku-4-5', name: 'Haiku', enabled: true }
	];
	generalSettings.providers = [
		{ id: 'provider-1', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'k' }
	];
}

function stubBrowserTranslator() {
	const translate = vi.fn(async (text: string) => `译:${text}`);
	(globalThis as any).Translator = {
		availability: vi.fn(async () => 'available'),
		create: vi.fn(async () => ({ translate }))
	};
	return translate;
}

const ARTICLE_DOM = `
	<div class="obsidian-reader-content">
		<article>
			<h1>How Banks Work</h1>
			<p id="p1">First paragraph about banks.</p>
			<p id="p2">Second paragraph about rates.</p>
			<pre><code>const rate = 0.05;</code></pre>
			<div class="youtube transcript">
				<div class="transcript-segment"><strong class="timestamp">0:01</strong><div class="transcript-segment-text" id="seg1">transcript line about banks</div></div>
			</div>
			<p id="p3">Third paragraph about markets.</p>
		</article>
	</div>`;

describe('full-article translation', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	beforeEach(() => {
		document.body.innerHTML = ARTICLE_DOM;
		document.documentElement.lang = 'en';
		FakeIntersectionObserver.instances = [];
		vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
		sendMessage.mockReset();
		clearTranslationCache();
		clearFullTranslationCache();
		configureLlm();
	});

	afterEach(() => {
		disableFullTranslation(document);
		delete (globalThis as any).Translator;
		vi.unstubAllGlobals();
	});

	test('observes content blocks and transcript text, skips code and timestamps', () => {
		enableFullTranslation(document, OPTS);

		const observedIds = io().observed.map(el => el.id || el.tagName.toLowerCase());
		expect(observedIds).toContain('p1');
		expect(observedIds).toContain('p2');
		expect(observedIds).toContain('p3');
		// Transcript segment TEXT translates; the timestamps do not
		expect(observedIds).toContain('seg1');
		expect(io().observed.some(el => el.closest('pre'))).toBe(false);
		expect(io().observed.some(el => el.matches('strong, .timestamp'))).toBe(false);
	});

	test('pending nodes show a visible loading placeholder', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const translate = vi.fn(async (text: string) => { await gate; return `译:${text}`; });
		(globalThis as any).Translator = {
			availability: vi.fn(async () => 'available'),
			create: vi.fn(async () => ({ translate }))
		};
		enableFullTranslation(document, OPTS);

		io().trigger([document.getElementById('p1')!]);
		await settle(2);

		const node = document.getElementById('p1')!.nextElementSibling as HTMLElement;
		expect(node.getAttribute('data-state')).toBe('pending');
		expect((node.textContent || '').length).toBeGreaterThan(0);

		release();
		await settle();
		expect(node.getAttribute('data-state')).toBe('done');
	});

	test('browser engine: intersecting blocks get pending → done comparison nodes', async () => {
		const translate = stubBrowserTranslator();
		enableFullTranslation(document, OPTS);

		io().trigger([document.getElementById('p1')!, document.getElementById('p2')!]);
		await settle();

		const nodes = document.querySelectorAll('.obsidian-reader-translation[data-origin="full"]');
		expect(nodes).toHaveLength(2);
		expect(nodes[0].getAttribute('data-state')).toBe('done');
		expect(nodes[0].textContent).toBe('译:First paragraph about banks.');
		expect(document.getElementById('p1')!.nextElementSibling).toBe(nodes[0]);
		expect(translate).toHaveBeenCalledTimes(2);
		// Untriggered blocks stay untranslated (viewport-proportional cost)
		expect(document.getElementById('p3')!.nextElementSibling?.classList.contains('obsidian-reader-translation')).toBeFalsy();
	});

	test('paragraph cache: toggling off and on again re-uses translations', async () => {
		const translate = stubBrowserTranslator();
		enableFullTranslation(document, OPTS);
		io().trigger([document.getElementById('p1')!]);
		await settle();

		disableFullTranslation(document);
		expect(document.querySelectorAll('.obsidian-reader-translation')).toHaveLength(0);

		enableFullTranslation(document, OPTS);
		io().trigger([document.getElementById('p1')!]);
		await settle();

		expect(document.querySelectorAll('.obsidian-reader-translation')).toHaveLength(1);
		expect(translate).toHaveBeenCalledTimes(1);
	});

	test('LLM path: one numbered batch per callback, glossary carried to later batches', async () => {
		let call = 0;
		sendMessage.mockImplementation(async (message: any) => {
			call++;
			const reply = call === 1
				? { translations: { '1': '第一段。', '2': '第二段。' }, keyTerms: [{ source: 'bank', target: '银行' }] }
				: { translations: { '1': '第三段。' } };
			return {
				ok: true, status: 200,
				text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn' })
			};
		});
		enableFullTranslation(document, OPTS);

		io().trigger([document.getElementById('p1')!, document.getElementById('p2')!]);
		await settle();
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const firstBody = JSON.parse((sendMessage.mock.calls[0][0] as any).options.body);
		const firstContent = firstBody.messages.map((m: { content: string }) => m.content).join('\n');
		expect(firstContent).toContain('[1] First paragraph about banks.');
		expect(firstContent).toContain('[2] Second paragraph about rates.');
		expect(document.getElementById('p2')!.nextElementSibling!.textContent).toBe('第二段。');

		io().trigger([document.getElementById('p3')!]);
		await settle();
		const secondBody = JSON.parse((sendMessage.mock.calls[1][0] as any).options.body);
		const secondContent = secondBody.messages.map((m: { content: string }) => m.content).join('\n');
		// The glossary from batch 1 travels into batch 2
		expect(secondContent).toContain('bank');
		expect(secondContent).toContain('银行');
	});

	test('LLM batch failure marks the affected nodes as errors, others unaffected', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 500, text: 'boom' });
		enableFullTranslation(document, OPTS);

		io().trigger([document.getElementById('p1')!]);
		await settle();

		const node = document.getElementById('p1')!.nextElementSibling!;
		expect(node.getAttribute('data-state')).toBe('error');
	});

	test('disable restores the article and leaves manually inserted comparisons alone', async () => {
		stubBrowserTranslator();
		// A manual comparison from the passage feature already exists
		const manual = document.createElement('p');
		manual.className = 'obsidian-reader-translation';
		manual.setAttribute('data-src-hash', 'manual');
		manual.textContent = '手动插入的对照。';
		document.getElementById('p3')!.after(manual);
		const snapshot = document.querySelector('article')!.innerHTML;

		enableFullTranslation(document, OPTS);
		io().trigger([document.getElementById('p1')!, document.getElementById('p2')!]);
		await settle();
		expect(isFullTranslationActive(document)).toBe(true);

		disableFullTranslation(document);

		expect(isFullTranslationActive(document)).toBe(false);
		expect(document.querySelector('article')!.innerHTML).toBe(snapshot);
	});

	test('manual comparison and full mode never adopt each other\'s nodes', async () => {
		stubBrowserTranslator();
		// A manual comparison on p1 whose hash matches what full mode computes
		// is still a distinct node (origin-scoped matching)
		enableFullTranslation(document, OPTS);
		io().trigger([document.getElementById('p1')!]);
		await settle();
		const fullNode = document.getElementById('p1')!.nextElementSibling as HTMLElement;
		expect(fullNode.getAttribute('data-origin')).toBe('full');
		const fullHash = fullNode.getAttribute('data-src-hash')!;

		// Manual insert with the same hash (as the passage feature would)
		const manual = document.createElement('p');
		manual.className = 'obsidian-reader-translation';
		manual.setAttribute('data-src-hash', fullHash);
		manual.textContent = '手动的语境级译文。';
		fullNode.after(manual);

		disableFullTranslation(document);

		// The full node is gone, the manual one survives untouched
		expect(document.querySelectorAll('.obsidian-reader-translation')).toHaveLength(1);
		expect(document.querySelector('.obsidian-reader-translation')!.textContent).toBe('手动的语境级译文。');
	});

	test('browser pair unavailable falls back to the configured LLM', async () => {
		(globalThis as any).Translator = {
			availability: vi.fn(async () => 'unavailable'),
			create: vi.fn()
		};
		sendMessage.mockResolvedValue({
			ok: true, status: 200,
			text: JSON.stringify({
				content: [{ type: 'text', text: JSON.stringify({ translations: { '1': '第一段。' } }) }],
				stop_reason: 'end_turn'
			})
		});
		enableFullTranslation(document, OPTS);

		io().trigger([document.getElementById('p1')!]);
		await settle(10);

		const node = document.getElementById('p1')!.nextElementSibling!;
		expect(node.getAttribute('data-state')).toBe('done');
		expect(node.textContent).toBe('第一段。');
		expect(sendMessage).toHaveBeenCalled();
	});

	test('ten enable/disable cycles leave no nodes and no live observers', async () => {
		stubBrowserTranslator();
		const snapshot = document.querySelector('article')!.innerHTML;

		for (let i = 0; i < 10; i++) {
			enableFullTranslation(document, OPTS);
			io().trigger([document.getElementById('p1')!]);
			await settle();
			disableFullTranslation(document);
		}

		expect(document.querySelector('article')!.innerHTML).toBe(snapshot);
		expect(FakeIntersectionObserver.instances).toHaveLength(10);
		expect(FakeIntersectionObserver.instances.every(i => i.observed.length === 0)).toBe(true);
	});

	test('per-URL memory round-trips through storage', async () => {
		const store: Record<string, any> = {};
		vi.spyOn(browser.storage.local, 'get').mockImplementation(async (key: any) => ({ [key]: store[key] }));
		vi.spyOn(browser.storage.local, 'set').mockImplementation(async (items: any) => { Object.assign(store, items); });

		await rememberFullTranslation('https://example.com/a', true);
		expect(await wasFullTranslationEnabled('https://example.com/a')).toBe(true);

		await rememberFullTranslation('https://example.com/a', false);
		expect(await wasFullTranslationEnabled('https://example.com/a')).toBe(false);
	});
});
