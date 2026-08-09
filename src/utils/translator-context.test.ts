// @vitest-environment jsdom
// Selection context extraction for translation (fork issue #3): given a DOM
// selection inside the reader article, produce the layered context (sentence,
// paragraph, article metadata) that grounds a context-aware translation.
import { describe, test, expect, beforeEach } from 'vitest';
import { classifySelection, extractSelectionContext } from './translator-context';

const ARTICLE = { title: 'How Banks Work', site: 'example.com', lang: 'en' };

function selectText(container: HTMLElement, needle: string): Selection {
	// Find the text node containing the needle and select exactly it
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
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

describe('classifySelection', () => {
	test('single word', () => {
		expect(classifySelection('bank')).toBe('word');
	});

	test('short phrase (2–4 words)', () => {
		expect(classifySelection('interest rates')).toBe('phrase');
		expect(classifySelection('raise the interest rates')).toBe('phrase');
	});

	test('five or more words is a passage', () => {
		expect(classifySelection('the bank raised the interest rates')).toBe('passage');
	});

	test('very long single-line selection is a passage regardless of word count', () => {
		expect(classifySelection('supercalifragilistic '.repeat(20))).toBe('passage');
	});
});

describe('extractSelectionContext', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	test('word mid-paragraph: sentence, paragraph and kind', () => {
		document.body.innerHTML = `
			<article>
				<p>Money moves fast. The bank raised interest rates yesterday. Markets reacted.</p>
			</article>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.selectedText).toBe('bank');
		expect(ctx.kind).toBe('word');
		expect(ctx.sentence).toBe('The bank raised interest rates yesterday.');
		expect(ctx.paragraph).toBe('Money moves fast. The bank raised interest rates yesterday. Markets reacted.');
		expect(ctx.article).toEqual(ARTICLE);
	});

	test('does not split the sentence at a title abbreviation', () => {
		document.body.innerHTML = `<p>It was raining. Dr. Smith went to the bank. He left.</p>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.sentence).toBe('Dr. Smith went to the bank.');
	});

	test('CJK sentence boundaries', () => {
		document.body.innerHTML = `<p>他昨天去了银行。今天在家休息。</p>`;
		const sel = selectText(document.body, '银行');

		const ctx = extractSelectionContext(sel, { ...ARTICLE, lang: 'zh' })!;

		expect(ctx.sentence).toBe('他昨天去了银行。');
	});

	test('English sentence inside a mixed CJK paragraph', () => {
		document.body.innerHTML = `<p>市场波动。The bank raised rates! 大家都在讨论。</p>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, { ...ARTICLE, lang: 'zh' })!;

		expect(ctx.sentence).toBe('The bank raised rates!');
	});

	test('selection spanning two sentences widens the sentence context', () => {
		document.body.innerHTML = `<p>Rates went up. Markets fell. Nobody was surprised.</p>`;
		const sel = selectText(document.body, 'up. Markets fell');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.sentence).toBe('Rates went up. Markets fell.');
	});

	test('resolves the containing block, not the whole article', () => {
		document.body.innerHTML = `
			<article>
				<p>First paragraph talks about markets.</p>
				<p>Second paragraph mentions the bank explicitly.</p>
				<p>Third paragraph wraps up.</p>
			</article>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.paragraph).toBe('Second paragraph mentions the bank explicitly.');
	});

	test('list items are their own blocks', () => {
		document.body.innerHTML = `<ul><li>Open an account.</li><li>Visit the bank today.</li></ul>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.paragraph).toBe('Visit the bank today.');
	});

	test('captures neighboring paragraphs for passage context', () => {
		document.body.innerHTML = `
			<article>
				<p>First paragraph sets the scene.</p>
				<p>Second paragraph mentions the bank explicitly and at length.</p>
				<p>Third paragraph wraps everything up.</p>
			</article>`;
		const sel = selectText(document.body, 'Second paragraph mentions the bank explicitly and at length.');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.kind).toBe('passage');
		expect(ctx.neighbors.before).toBe('First paragraph sets the scene.');
		expect(ctx.neighbors.after).toBe('Third paragraph wraps everything up.');
	});

	test('first paragraph has no before-neighbor; neighbors are truncated', () => {
		const long = 'word '.repeat(200).trim();
		document.body.innerHTML = `
			<article>
				<p>Opening paragraph selected here.</p>
				<p>${long}</p>
			</article>`;
		const sel = selectText(document.body, 'Opening paragraph selected here.');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.neighbors.before).toBeUndefined();
		expect(ctx.neighbors.after!.length).toBeLessThanOrEqual(500);
	});

	test('neighbor walk skips inserted translation nodes', () => {
		document.body.innerHTML = `
			<article>
				<p>Original first paragraph.</p>
				<div class="obsidian-reader-translation">已插入的译文。</div>
				<p>Selected second paragraph body text.</p>
			</article>`;
		const sel = selectText(document.body, 'Selected second paragraph body text.');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.neighbors.before).toBe('Original first paragraph.');
	});

	test('exposes the containing block element for comparison insertion', () => {
		document.body.innerHTML = `<article><p id="target">Selected paragraph text.</p></article>`;
		const sel = selectText(document.body, 'Selected paragraph text.');

		const ctx = extractSelectionContext(sel, ARTICLE)!;

		expect(ctx.blockElement).toBe(document.getElementById('target'));
	});

	test('collapsed selection returns null', () => {
		document.body.innerHTML = `<p>Some text.</p>`;
		const sel = window.getSelection()!;
		sel.removeAllRanges();

		expect(extractSelectionContext(sel, ARTICLE)).toBeNull();
	});

	test('falls back to a usable sentence when the language tag is invalid', () => {
		document.body.innerHTML = `<p>Rates went up. The bank benefited.</p>`;
		const sel = selectText(document.body, 'bank');

		const ctx = extractSelectionContext(sel, { ...ARTICLE, lang: 'not a lang!!' })!;

		expect(ctx.sentence).toBe('The bank benefited.');
	});
});
