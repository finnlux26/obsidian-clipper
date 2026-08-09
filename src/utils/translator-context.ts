// Selection context extraction for translation (fork issue #3). Given a DOM
// selection inside the reader article, produce the layered context that
// grounds a context-aware translation: the containing sentence (decisive for
// word-level polysemy), the containing block's full text, and the article
// metadata defuddle already extracted.

export type SelectionKind = 'word' | 'phrase' | 'passage';

export interface ArticleMeta {
	title: string;
	site: string;
	lang: string;
}

export interface SelectionContext {
	selectedText: string;
	kind: SelectionKind;
	sentence: string;
	paragraph: string;
	article: ArticleMeta;
}

const BLOCK_SELECTOR = 'p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6, figcaption, dd, dt, pre';

// Selections longer than this are a passage no matter the word count
const PASSAGE_CHAR_THRESHOLD = 300;
const PHRASE_MAX_WORDS = 4;

// ICU sentence segmentation splits after common titles ("Dr. Smith" →
// "Dr. " + "Smith…"); merge those segments back together
const ABBREVIATION_END = /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|approx|dept|est|Fig|No)\.\s*$/i;

export function classifySelection(text: string): SelectionKind {
	const trimmed = text.trim();
	if (trimmed.length > PASSAGE_CHAR_THRESHOLD) return 'passage';
	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length <= 1) return 'word';
	if (words.length <= PHRASE_MAX_WORDS) return 'phrase';
	return 'passage';
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function resolveBlock(range: Range): HTMLElement | null {
	const start = range.startContainer;
	const element = start.nodeType === Node.ELEMENT_NODE
		? (start as HTMLElement)
		: start.parentElement;
	return element?.closest(BLOCK_SELECTOR) ?? null;
}

interface SentenceSegment {
	start: number;
	end: number;
}

// The project lib target predates Intl.Segmenter typings — minimal local shape
interface SegmenterLike {
	segment(text: string): Iterable<{ segment: string; index: number }>;
}
type SegmenterCtor = new (lang?: string, options?: { granularity: 'sentence' }) => SegmenterLike;

function segmentSentences(text: string, lang: string): SentenceSegment[] {
	let segments: SentenceSegment[] = [];

	const Segmenter = typeof Intl !== 'undefined'
		? (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
		: undefined;
	if (Segmenter) {
		let segmenter: SegmenterLike;
		try {
			segmenter = new Segmenter(lang || undefined, { granularity: 'sentence' });
		} catch {
			// Invalid language tag — fall back to locale-independent segmentation
			segmenter = new Segmenter(undefined, { granularity: 'sentence' });
		}
		for (const s of segmenter.segment(text)) {
			segments.push({ start: s.index, end: s.index + s.segment.length });
		}
	} else {
		// Environments without Intl.Segmenter: split after sentence punctuation
		const re = /[^.!?。!?]*[.!?。!?]+["'"』」)]?\s*|[^.!?。!?]+$/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(text)) !== null && match[0].length > 0) {
			segments.push({ start: match.index, end: match.index + match[0].length });
		}
	}

	if (segments.length === 0) {
		return [{ start: 0, end: text.length }];
	}

	// Merge segments that end in a known abbreviation with their successor
	const merged: SentenceSegment[] = [];
	for (const seg of segments) {
		const prev = merged[merged.length - 1];
		if (prev && ABBREVIATION_END.test(text.slice(prev.start, prev.end))) {
			prev.end = seg.end;
		} else {
			merged.push({ ...seg });
		}
	}
	return merged;
}

export function extractSelectionContext(selection: Selection, article: ArticleMeta): SelectionContext | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

	const range = selection.getRangeAt(0);
	const selectedText = collapseWhitespace(range.toString());
	if (!selectedText) return null;

	const block = resolveBlock(range);
	if (!block) {
		return {
			selectedText,
			kind: classifySelection(selectedText),
			sentence: selectedText,
			paragraph: selectedText,
			article
		};
	}

	const blockText = block.textContent || '';

	// Character offsets of the selection within the block, measured on the
	// raw text so they line up with the sentence segmentation below
	const doc = block.ownerDocument;
	const pre = doc.createRange();
	pre.selectNodeContents(block);
	pre.setEnd(range.startContainer, range.startOffset);
	const selStart = pre.toString().length;
	const selEnd = selStart + range.toString().length;

	// The sentence context covers every sentence the selection touches
	const segments = segmentSentences(blockText, article.lang);
	let sentenceStart = 0;
	let sentenceEnd = blockText.length;
	const first = segments.find(s => selStart >= s.start && selStart < s.end)
		?? segments[segments.length - 1];
	const last = segments.find(s => selEnd > s.start && selEnd <= s.end)
		?? segments[segments.length - 1];
	sentenceStart = first.start;
	sentenceEnd = last.end;

	return {
		selectedText,
		kind: classifySelection(selectedText),
		sentence: collapseWhitespace(blockText.slice(sentenceStart, sentenceEnd)),
		paragraph: collapseWhitespace(blockText),
		article
	};
}
