import Defuddle from 'defuddle/full';
import { setElementHTML } from './dom-utils';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		// Clips save the original article: inserted translation comparison
		// nodes are runtime UI, not content (the removal happens on the
		// clone, never on the live reader DOM)
		readerDoc.querySelectorAll('.obsidian-reader-translation').forEach(n => n.remove());
		return new Defuddle(readerDoc, { url: '' }).parse();
	}
	return new Defuddle(doc, { url: doc.URL }).parse();
}
