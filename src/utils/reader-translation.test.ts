// @vitest-environment jsdom
// Reader translation UI (fork issue #3): the floating Translate affordance
// and the result popover. Network is mocked at the fetchProxy seam only;
// copy assertions use the resolved en locale strings.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { shouldOfferTranslation, openTranslationPopover } from './reader-translation';
import { clearTranslationCache } from './translator';
import { generalSettings } from './storage-utils';
import { SelectionContext } from './translator-context';

const CTX: SelectionContext = {
	selectedText: 'bank',
	kind: 'word',
	sentence: 'The bank raised interest rates yesterday.',
	paragraph: 'The bank raised interest rates yesterday.',
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

	test('not offered for a passage-length selection (deferred to a later ticket)', () => {
		const sel = selectInArticle('The bank raised interest rates yesterday. Everyone noticed');
		expect(shouldOfferTranslation(sel, document)).toBe(false);
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
		configureLlm();
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
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('shows a failure message when the request fails', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 500, text: 'server exploded' });

		const popover = openTranslationPopover(document, CTX, 'zh');

		await vi.waitFor(() => {
			expect(popover.getAttribute('data-state')).toBe('error');
		});
		expect(popover.textContent).toContain('Translation failed');
	});

	test('Escape closes the popover', async () => {
		proxyRepliesWith({ translation: '银行' });

		const popover = openTranslationPopover(document, CTX, 'zh');
		await vi.waitFor(() => expect(popover.getAttribute('data-state')).toBe('done'));

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(document.querySelector('.obsidian-translate-popover')).toBeNull();
	});
});
