// @vitest-environment jsdom
// YouTube descriptions often contain literal markdown link syntax around
// auto-linked bare URLs: "[Label](<a>https://…</a>)". linkifyMarkdownLinks
// folds the syntax into the anchor so the reader shows "Label" as the link.
// A markdown clip of the result round-trips to the identical source text.
import { describe, test, expect } from 'vitest';
import { linkifyMarkdownLinks } from './markdown-links';

function container(html: string): HTMLElement {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div;
}

describe('linkifyMarkdownLinks', () => {
	test('folds [label](<a>url</a>) into a labeled anchor', () => {
		const el = container('See [X/Twitter](<a href="https://x.com/_p">https://x.com/_p</a>) · more');
		linkifyMarkdownLinks(el);
		const a = el.querySelector('a')!;
		expect(a.textContent).toBe('X/Twitter');
		expect(a.getAttribute('href')).toBe('https://x.com/_p');
		expect(el.textContent).toBe('See X/Twitter · more');
	});

	test('handles several links in one text run', () => {
		const el = container(
			'[A](<a href="https://a.example">https://a.example</a>) · [B](<a href="https://b.example">https://b.example</a>)'
		);
		linkifyMarkdownLinks(el);
		const anchors = el.querySelectorAll('a');
		expect(anchors[0].textContent).toBe('A');
		expect(anchors[1].textContent).toBe('B');
		expect(el.textContent).toBe('A · B');
	});

	test('leaves anchors whose text is not the bare URL alone', () => {
		const el = container('read [docs](<a href="https://d.example">the docs</a>) now');
		linkifyMarkdownLinks(el);
		expect(el.textContent).toBe('read [docs](the docs) now');
	});

	test('leaves plain auto-linked URLs without markdown syntax alone', () => {
		const el = container('visit <a href="https://a.example">https://a.example</a> today');
		linkifyMarkdownLinks(el);
		expect(el.textContent).toBe('visit https://a.example today');
		expect(el.querySelector('a')!.textContent).toBe('https://a.example');
	});

	test('tolerates a trailing slash difference between href and text', () => {
		const el = container('[Site](<a href="https://s.example/">https://s.example/</a>)');
		linkifyMarkdownLinks(el);
		expect(el.querySelector('a')!.textContent).toBe('Site');
		expect(el.textContent).toBe('Site');
	});

	test('ignores markdown-looking text with no adjacent anchor', () => {
		const el = container('literal [not a link](just text) here');
		linkifyMarkdownLinks(el);
		expect(el.textContent).toBe('literal [not a link](just text) here');
	});
});
