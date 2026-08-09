// @vitest-environment jsdom
// Reader translation UI (fork issue #3): the floating Translate affordance
// and the result popover. Network is mocked at the fetchProxy seam only;
// copy assertions use the resolved en locale strings.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { shouldOfferTranslation, openTranslationPopover } from './reader-translation';
import { clearTranslationCache } from './translator';
import { clearPhoneticsCache } from './dictionary';
import { generalSettings } from './storage-utils';
import { SelectionContext } from './translator-context';

const CTX: SelectionContext = {
	selectedText: 'bank',
	kind: 'word',
	sentence: 'The bank raised interest rates yesterday.',
	paragraph: 'The bank raised interest rates yesterday.',
	neighbors: {},
	article: { title: 'How Banks Work', site: 'example.com', lang: 'en' }
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

function selectInArticle(needle: string): Selection {
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		const idx = node.data.indexOf(needle);
		if (idx >= 0) {
			const range = document.createRange();
			range.setStart(node, idx);
			range.setEnd(node, idx + needle.length);
			const sel = window.getSelection()!;
			sel.removeAllRanges();
			sel.addRange(range);
			return sel;
		}
	}
	throw new Error(`needle not found: ${needle}`);
}

const READER_DOM = `
	<div class="obsidian-reader-content">
		<article>
			<h1>How Banks Work</h1>
			<p>The bank raised interest rates yesterday. Everyone noticed the change immediately.</p>
		</article>
	</div>
	<p id="outside">Text outside the reader article mentions a bank too.</p>`;

describe('shouldOfferTranslation', () => {
	beforeEach(() => {
		document.body.innerHTML = READER_DOM;
	});

	test('offered for a word selected inside the article', () => {
		const sel = selectInArticle('bank');
		expect(shouldOfferTranslation(sel, document)).toBe(true);
	});

	test('offered for a short phrase', () => {
		const sel = selectInArticle('interest rates');
		expect(shouldOfferTranslation(sel, document)).toBe(true);
	});

	test('offered for a passage-length selection', () => {
		const sel = selectInArticle('The bank raised interest rates yesterday. Everyone noticed');
		expect(shouldOfferTranslation(sel, document)).toBe(true);
	});

	test('not offered outside the reader article', () => {
		const outside = document.getElementById('outside')!;
		const range = document.createRange();
		const textNode = outside.firstChild as Text;
		const idx = textNode.data.indexOf('bank');
		range.setStart(textNode, idx);
		range.setEnd(textNode, idx + 4);
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		sel.addRange(range);

		expect(shouldOfferTranslation(sel, document)).toBe(false);
	});

	test('not offered for a collapsed selection', () => {
		const sel = window.getSelection()!;
		sel.removeAllRanges();
		expect(shouldOfferTranslation(sel, document)).toBe(false);
	});
});

describe('openTranslationPopover', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	beforeEach(() => {
		document.body.innerHTML = READER_DOM;
		sendMessage.mockReset();
		clearTranslationCache();
		clearPhoneticsCache();
		configureLlm();
		generalSettings.readerSettings = {
			...generalSettings.readerSettings,
			dictionaryLookupEnabled: true
		};
	});

	function proxyRepliesWith(result: unknown) {
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({
				content: [{ type: 'text', text: JSON.stringify(result) }],
				stop_reason: 'end_turn'
			})
		});
	}

	test('renders pending then done with the translation fields', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		sendMessage.mockImplementation(async () => {
			await gate;
			return {
				ok: true,
				status: 200,
				text: JSON.stringify({
					content: [{
						type: 'text',
						text: JSON.stringify({
							translation: '银行',
							partOfSpeech: 'noun',
							meaningInContext: '此处指金融机构。',
							otherCommonMeanings: ['河岸']
						})
					}],
					stop_reason: 'end_turn'
				})
			};
		});

		const popover = openTranslationPopover(document, CTX, 'zh');
		expect(popover.getAttribute('data-state')).toBe('pending');
		expect(document.querySelectorAll('.obsidian-translate-popover')).toHaveLength(1);

		release();
		await vi.waitFor(() => {
			expect(popover.getAttribute('data-state')).toBe('done');
		});
		expect(popover.textContent).toContain('银行');
		expect(popover.textContent).toContain('noun');
		expect(popover.textContent).toContain('此处指金融机构。');
		expect(popover.textContent).toContain('河岸');
	});

	test('opening a second popover replaces the first', async () => {
		proxyRepliesWith({ translation: '银行' });

		openTranslationPopover(document, CTX, 'zh');
		const second = openTranslationPopover(document, CTX, 'zh');

		expect(document.querySelectorAll('.obsidian-translate-popover')).toHaveLength(1);
		expect(document.querySelector('.obsidian-translate-popover')).toBe(second);
	});

	test('shows an actionable message when no engine is configured', async () => {
		generalSettings.interpreterEnabled = false;

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => {
			expect(popover.getAttribute('data-state')).toBe('error');
		});
		// The actionable "configure interpreter" copy, resolved from en locale
		expect(popover.textContent).toContain('Set up an Interpreter model');
		// No LLM request left the extension (the dictionary lookup is
		// independent of the LLM engine and may still fire)
		const llmCalls = sendMessage.mock.calls
			.filter(c => String((c[0] as any).url).includes('api.anthropic.com'));
		expect(llmCalls).toHaveLength(0);
	});

	test('shows a failure message when the request fails', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 500, text: 'server exploded' });

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => {
			expect(popover.getAttribute('data-state')).toBe('error');
		});
		expect(popover.textContent).toContain('Translation failed');
	});

	function proxyRoutesDictionaryAndLlm(options: { dictionaryHit: boolean; llmResult: unknown }) {
		sendMessage.mockImplementation(async (message: any) => {
			const url = String(message.url);
			if (url.includes('dictionaryapi.dev') || url.includes('/entries/')) {
				if (!options.dictionaryHit) {
					return { ok: false, status: 404, text: '{}' };
				}
				return {
					ok: true, status: 200,
					text: JSON.stringify([{
						word: 'bank',
						phonetics: [
							{ text: '/bæŋk/', audio: 'https://x.test/bank-uk.mp3' },
							{ text: '/bæŋk/', audio: 'https://x.test/bank-us.mp3' }
						]
					}])
				};
			}
			return {
				ok: true, status: 200,
				text: JSON.stringify({
					content: [{ type: 'text', text: JSON.stringify(options.llmResult) }],
					stop_reason: 'end_turn'
				})
			};
		});
	}

	test('renders UK/US phonetics with audio buttons for an English word', async () => {
		proxyRoutesDictionaryAndLlm({ dictionaryHit: true, llmResult: { translation: '银行' } });

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => {
			expect(popover.querySelector('.obsidian-translate-phonetics')).not.toBeNull();
		});
		const row = popover.querySelector('.obsidian-translate-phonetics')!;
		expect(row.textContent).toContain('/bæŋk/');
		expect(row.textContent).toContain('UK');
		expect(row.textContent).toContain('US');
		expect(row.querySelectorAll('button.obsidian-translate-audio')).toHaveLength(2);
	});

	test('dictionary miss falls back to the LLM-provided IPA marked as approximate', async () => {
		proxyRoutesDictionaryAndLlm({
			dictionaryHit: false,
			llmResult: { translation: '银行', ipa: '/bæŋk/' }
		});

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));
		await vi.waitFor(() => {
			const row = popover.querySelector('.obsidian-translate-phonetics');
			expect(row?.textContent).toContain('/bæŋk/');
		});
		expect(popover.querySelector('.obsidian-translate-phonetics')!.textContent)
			.toContain('approx');
		expect(popover.querySelectorAll('button.obsidian-translate-audio')).toHaveLength(0);
	});

	test('dictionary failure never blocks the translation itself', async () => {
		proxyRoutesDictionaryAndLlm({ dictionaryHit: false, llmResult: { translation: '银行' } });

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));
		expect(popover.textContent).toContain('银行');
		expect(popover.querySelector('.obsidian-translate-phonetics')).toBeNull();
	});

	test('privacy switch off: no dictionary request leaves the extension', async () => {
		generalSettings.readerSettings = {
			...generalSettings.readerSettings,
			dictionaryLookupEnabled: false
		};
		proxyRoutesDictionaryAndLlm({ dictionaryHit: true, llmResult: { translation: '银行' } });

		const popover = openTranslationPopover(document, CTX, 'zh');
		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));

		const urls = sendMessage.mock.calls.map(c => String((c[0] as any).url));
		expect(urls.some(u => u.includes('dictionaryapi') || u.includes('/entries/'))).toBe(false);
	});

	function passageCtxFromDom(): SelectionContext {
		const block = document.querySelector('.obsidian-reader-content article p') as HTMLElement;
		return {
			selectedText: 'The bank raised interest rates yesterday. Everyone noticed the change immediately.',
			kind: 'passage',
			sentence: 'The bank raised interest rates yesterday.',
			paragraph: block.textContent!.trim(),
			neighbors: {},
			article: CTX.article,
			blockElement: block
		};
	}

	test('passage popover renders the translation with an insert-as-comparison action', async () => {
		proxyRepliesWith({ translation: '银行昨天加息了。所有人立刻注意到了变化。' });

		const popover = openTranslationPopover(document, passageCtxFromDom(), 'zh');

		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));
		expect(popover.textContent).toContain('银行昨天加息了');
		expect(popover.querySelector('button.obsidian-translate-insert')).not.toBeNull();
	});

	test('insert-as-comparison adds a sibling node and leaves the original untouched', async () => {
		proxyRepliesWith({ translation: '译文段落。' });
		const ctx = passageCtxFromDom();
		const originalOuterHtml = ctx.blockElement!.outerHTML;

		const popover = openTranslationPopover(document, ctx, 'zh');
		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));
		(popover.querySelector('button.obsidian-translate-insert') as HTMLButtonElement).click();

		const inserted = ctx.blockElement!.nextElementSibling as HTMLElement;
		expect(inserted.classList.contains('obsidian-reader-translation')).toBe(true);
		expect(inserted.getAttribute('data-src-hash')).toBeTruthy();
		expect(inserted.textContent).toBe('译文段落。');
		// The original paragraph node is byte-identical — highlight anchors survive
		expect(ctx.blockElement!.outerHTML).toBe(originalOuterHtml);
	});

	test('inserting twice does not duplicate the comparison node', async () => {
		proxyRepliesWith({ translation: '译文段落。' });
		const ctx = passageCtxFromDom();

		const popover = openTranslationPopover(document, ctx, 'zh');
		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));
		const btn = popover.querySelector('button.obsidian-translate-insert') as HTMLButtonElement;
		btn.click();
		btn.click();

		expect(document.querySelectorAll('.obsidian-reader-translation')).toHaveLength(1);
	});

	test('over-long passage selections get a split hint instead of a silent truncation', async () => {
		proxyRepliesWith({ translation: 'x' });
		const ctx = { ...passageCtxFromDom(), selectedText: 'y'.repeat(3200) };

		const popover = openTranslationPopover(document, ctx, 'zh');

		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('error'));
		expect(popover.textContent).toContain('too long');
		const llmCalls = sendMessage.mock.calls
			.filter(c => String((c[0] as any).url).includes('api.anthropic.com'));
		expect(llmCalls).toHaveLength(0);
	});

	test('Escape closes the popover', async () => {
		proxyRepliesWith({ translation: '银行' });

		const popover = openTranslationPopover(document, CTX, 'zh');
		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(document.querySelector('.obsidian-translate-popover')).toBeNull();
	});
});
