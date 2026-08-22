// YouTube descriptions (and similar plain-text sources) often contain
// literal markdown link syntax around URLs the extractor auto-linked:
// "[Label](<a>https://…</a>)". In the reader that renders as noise. When
// the anchor's text is the bare URL itself, fold the syntax into the
// anchor: <a href="url">Label</a>. A markdown clip of the result converts
// back to "[Label](url)" — byte-identical to the source text — so this is
// a display improvement with no clipping-fidelity cost.

const LABEL_BEFORE = /\[([^\][]{1,120})\]\(\s*$/;
const PAREN_AFTER = /^\s*\)/;

function isBareUrlAnchor(anchor: HTMLAnchorElement): boolean {
	const href = anchor.getAttribute('href') || '';
	const text = (anchor.textContent || '').trim();
	if (!href || !text) return false;
	return text === href || text + '/' === href || text === href + '/';
}

export function linkifyMarkdownLinks(root: ParentNode): void {
	for (const anchor of Array.from(root.querySelectorAll('a'))) {
		if (!isBareUrlAnchor(anchor)) continue;
		const prev = anchor.previousSibling;
		const next = anchor.nextSibling;
		if (!prev || prev.nodeType !== Node.TEXT_NODE) continue;
		if (!next || next.nodeType !== Node.TEXT_NODE) continue;
		const labelMatch = LABEL_BEFORE.exec(prev.textContent || '');
		if (!labelMatch) continue;
		if (!PAREN_AFTER.test(next.textContent || '')) continue;
		prev.textContent = (prev.textContent || '').slice(0, labelMatch.index);
		next.textContent = (next.textContent || '').replace(PAREN_AFTER, '');
		anchor.textContent = labelMatch[1];
	}
}
