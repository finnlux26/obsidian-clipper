// Full-article bilingual mode (fork issue #9). Blocks translate lazily as
// they approach the viewport — cost tracks reading progress, not article
// length. The local browser engine translates per block; the LLM path packs
// each IntersectionObserver delivery into numbered batches and carries a
// session glossary so terminology stays consistent across batches. Inserted
// nodes are marked data-origin="full" so toggling off removes exactly what
// this mode added and nothing else.
import browser from './browser-polyfill';
import { getMessage } from './i18n';
import { getLocalStorage, setLocalStorage } from './storage-utils';
import { ArticleMeta } from './translator-context';
import {
	GlossaryEntry,
	browserTranslateText,
	getFullTextEngineKind,
	hasLlmEngine,
	translateBatchLlm
} from './translator';
import { ensureTranslationNode, hashText, notifyTranslationMutation } from './reader-translation';
import { debugLog } from './debug';

export interface FullTranslationOptions {
	targetLanguage: string;
	article: ArticleMeta;
	url: string;
}

const TRANSLATION_NODE_CLASS = 'obsidian-reader-translation';
export const FULL_TRANSLATION_NAV_BUTTON_CLASS = 'nav-btn-translate';
// .transcript-segment-text: the text wrapper wireTranscript creates per
// YouTube transcript segment — the timestamps (<strong>) stay untranslated
const CONTENT_BLOCK_SELECTOR = 'p, li, blockquote, h2, h3, h4, h5, h6, figcaption, dd, dt, td, th, .transcript-segment-text';
const SKIP_CONTAINER_SELECTOR = 'pre, code';

// LLM batches pack consecutive blocks up to this budget (chars)
const BATCH_CHAR_BUDGET = 2500;
const GLOSSARY_CAP = 40;
const MEMORY_STORAGE_KEY = 'readerFullTranslationUrls';
const MEMORY_CAP = 300;

interface FullTranslationState {
	observer: { disconnect(): void };
	opts: FullTranslationOptions;
	glossary: GlossaryEntry[];
}

const states = new WeakMap<Document, FullTranslationState>();

// Session cache: paragraph text + target language → translation. Survives
// toggling within the page's lifetime so re-enabling is free.
const fullTextCache = new Map<string, string>();

export function clearFullTranslationCache(): void {
	fullTextCache.clear();
}

export function isFullTranslationActive(doc: Document): boolean {
	return states.has(doc);
}

function collectBlocks(doc: Document): HTMLElement[] {
	const article = doc.querySelector('.obsidian-reader-content article');
	if (!article) return [];
	return (Array.from(article.querySelectorAll(CONTENT_BLOCK_SELECTOR)) as HTMLElement[])
		.filter(el => {
			if (el.closest(SKIP_CONTAINER_SELECTOR)) return false;
			if (el.classList.contains(TRANSLATION_NODE_CLASS) || el.closest(`.${TRANSLATION_NODE_CLASS}`)) return false;
			// Leaf blocks only: a list item wrapping paragraphs would double-translate
			if (el.querySelector(CONTENT_BLOCK_SELECTOR)) return false;
			return (el.textContent || '').trim().length >= 2;
		});
}

function blockText(block: HTMLElement): string {
	return (block.textContent || '').replace(/\s+/g, ' ').trim();
}

// A <br>-separated block (YouTube descriptions arrive as one <p> with
// dozens of <br> line breaks) translates per line, not as one giant unit —
// otherwise the whole description renders as a single translation slab at
// the block's end instead of under each line.
interface LineUnit {
	text: string;
	// The <br> ending the line; the translation span goes right after it.
	// null → last line, append at the block end.
	anchor: ChildNode | null;
}

function splitBrLines(block: HTMLElement): LineUnit[] | null {
	const lines: LineUnit[] = [];
	let text = '';
	let sawBr = false;
	const closeLine = (anchor: ChildNode | null) => {
		const t = text.replace(/\s+/g, ' ').trim();
		if (t.length >= 2) lines.push({ text: t, anchor });
		text = '';
	};
	for (const child of Array.from(block.childNodes)) {
		const el = child.nodeType === 1 ? (child as HTMLElement) : null;
		if (el && el.tagName === 'BR') {
			sawBr = true;
			closeLine(child);
		} else if (el && el.classList.contains(TRANSLATION_NODE_CLASS)) {
			continue;
		} else {
			text += child.textContent || '';
		}
	}
	closeLine(null);
	if (!sawBr || lines.length < 2) return null;
	return lines;
}

// Cache key is the full text — a 32-bit hash would silently collide
// across this module-lifetime cache; hashText is only for data-src-hash
function cacheKeyFor(text: string, targetLanguage: string): string {
	return targetLanguage + '\u0000' + text;
}

// A visible placeholder — an empty pending node renders as a barely
// visible 2px rule, which reads as "the button did nothing"
function applyPendingPlaceholder(node: HTMLElement): HTMLElement {
	if (node.getAttribute('data-state') === 'pending' && !node.textContent) {
		node.textContent = getMessage('translationLoading');
	}
	return node;
}

function insertLineNode(doc: Document, block: HTMLElement, line: LineUnit, hash: string): HTMLElement {
	const existing = block.querySelector(
		`:scope > .${TRANSLATION_NODE_CLASS}[data-origin="full"][data-src-hash="${hash}"]`
	);
	if (existing) return existing as HTMLElement;
	const node = doc.createElement('span');
	node.className = `${TRANSLATION_NODE_CLASS} obsidian-reader-translation-line`;
	node.setAttribute('data-origin', 'full');
	node.setAttribute('data-src-hash', hash);
	node.setAttribute('data-state', 'pending');
	if (line.anchor && line.anchor.parentNode === block) {
		(line.anchor as ChildNode).after(node);
	} else {
		block.appendChild(node);
	}
	notifyTranslationMutation(doc);
	return node;
}

// A block expands to one unit (the block itself) or one unit per <br> line
function unitsFor(doc: Document, block: HTMLElement, targetLanguage: string): Array<{ text: string; node: HTMLElement }> {
	const lines = splitBrLines(block);
	if (!lines) {
		const text = blockText(block);
		if (!text) return [];
		const node = ensureTranslationNode(doc, block, hashText(cacheKeyFor(text, targetLanguage)), 'full');
		return [{ text, node: applyPendingPlaceholder(node) }];
	}
	return lines.map((line, index) => {
		// Hash includes the line index so duplicate lines get distinct nodes
		const hash = hashText(index + ':' + cacheKeyFor(line.text, targetLanguage));
		return { text: line.text, node: applyPendingPlaceholder(insertLineNode(doc, block, line, hash)) };
	});
}

function fillNode(node: HTMLElement, translation: string): void {
	node.textContent = translation;
	node.setAttribute('data-state', 'done');
	notifyTranslationMutation(node.ownerDocument);
}

function failNode(node: HTMLElement): void {
	node.textContent = getMessage('translationFailed');
	node.setAttribute('data-state', 'error');
	notifyTranslationMutation(node.ownerDocument);
}

function mergeGlossary(state: FullTranslationState, terms: GlossaryEntry[]): void {
	for (const term of terms) {
		const exists = state.glossary.some(t => t.source.toLowerCase() === term.source.toLowerCase());
		if (!exists && state.glossary.length < GLOSSARY_CAP) {
			state.glossary.push(term);
		}
	}
}

async function translateBlocks(doc: Document, state: FullTranslationState, blocks: HTMLElement[]): Promise<void> {
	const { targetLanguage, article } = state.opts;

	// Serve cache hits immediately; the rest go to the engine
	const misses: Array<{ text: string; node: HTMLElement }> = [];
	for (const block of blocks) {
		for (const unit of unitsFor(doc, block, targetLanguage)) {
			const { text, node } = unit;
			const cached = fullTextCache.get(cacheKeyFor(text, targetLanguage));
			if (cached) {
				fillNode(node, cached);
			} else if (node.getAttribute('data-state') !== 'done') {
				misses.push({ text, node });
			}
		}
	}
	if (misses.length === 0) return;

	const engine = getFullTextEngineKind();
	if (!engine) {
		misses.forEach(({ node }) => failNode(node));
		return;
	}

	let llmMisses = misses;
	if (engine === 'browser') {
		const failures: typeof misses = [];
		await Promise.all(misses.map(async miss => {
			const { text, node } = miss;
			try {
				const translation = await browserTranslateText(text, article.lang, targetLanguage);
				fullTextCache.set(cacheKeyFor(text, targetLanguage), translation);
				if (node.isConnected) fillNode(node, translation);
			} catch (error) {
				debugLog('FullTranslation', 'Browser engine failed:', error);
				failures.push(miss);
			}
		}));
		// The Translator API exists but this language pair is unavailable
		// (or the model failed wholesale): fall through to the LLM if one is
		// configured, otherwise mark the nodes as errors
		if (failures.length === misses.length && hasLlmEngine()) {
			llmMisses = failures;
		} else {
			failures.forEach(({ node }) => {
				if (node.isConnected) failNode(node);
			});
			return;
		}
	}

	// LLM path: pack into numbered batches within the char budget
	const misses2 = llmMisses;
	const batches: Array<typeof misses> = [];
	let current: typeof misses = [];
	let currentChars = 0;
	for (const miss of misses2) {
		if (current.length > 0 && currentChars + miss.text.length > BATCH_CHAR_BUDGET) {
			batches.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(miss);
		currentChars += miss.text.length;
	}
	if (current.length > 0) batches.push(current);

	// Sequential on purpose: batches are glossary-chained — terms extracted
	// from one batch inform the next; typical delivery is 1-3 batches
	for (const batch of batches) {
		try {
			const result = await translateBatchLlm(
				batch.map(m => m.text),
				targetLanguage,
				article,
				state.glossary.slice()
			);
			mergeGlossary(state, result.keyTerms);
			batch.forEach(({ text, node }, index) => {
				const translation = result.translations[index];
				if (translation) {
					fullTextCache.set(cacheKeyFor(text, targetLanguage), translation);
					if (node.isConnected) fillNode(node, translation);
				} else if (node.isConnected) {
					failNode(node);
				}
			});
		} catch (error) {
			debugLog('FullTranslation', 'Batch failed:', error);
			batch.forEach(({ node }) => {
				if (node.isConnected) failNode(node);
			});
		}
	}
}

export function enableFullTranslation(doc: Document, opts: FullTranslationOptions): void {
	if (states.has(doc)) return;

	const win = doc.defaultView || window;
	const ObserverCtor = (win as any).IntersectionObserver || (globalThis as any).IntersectionObserver;
	let state: FullTranslationState;
	const observer = new ObserverCtor((entries: IntersectionObserverEntry[]) => {
		// The observer batches entries per delivery — that batching is our
		// request batching too
		const ready = entries.filter(e => e.isIntersecting).map(e => e.target as HTMLElement);
		if (ready.length === 0) return;
		ready.forEach(el => observer.unobserve(el));
		void translateBlocks(doc, state, ready);
	}, { rootMargin: '100% 0px' });
	state = { observer, opts, glossary: [] };
	states.set(doc, state);

	collectBlocks(doc).forEach(block => observer.observe(block));
}

export function disableFullTranslation(doc: Document): void {
	const state = states.get(doc);
	if (!state) return;
	state.observer.disconnect();
	states.delete(doc);
	// Remove exactly what this mode inserted; manual comparisons stay
	doc.querySelectorAll(`.${TRANSLATION_NODE_CLASS}[data-origin="full"]`).forEach(n => n.remove());
}

export function toggleFullTranslation(doc: Document, opts: FullTranslationOptions): boolean {
	if (isFullTranslationActive(doc)) {
		disableFullTranslation(doc);
		void rememberFullTranslation(opts.url, false);
		return false;
	}
	enableFullTranslation(doc, opts);
	void rememberFullTranslation(opts.url, true);
	return true;
}

// --- Per-URL memory -------------------------------------------------------

// Fragment variants are the same reading position for memory purposes
function normalizeMemoryUrl(url: string): string {
	return url.split('#')[0];
}

export async function rememberFullTranslation(rawUrl: string, enabled: boolean): Promise<void> {
	const url = normalizeMemoryUrl(rawUrl);
	try {
		const stored = (await getLocalStorage(MEMORY_STORAGE_KEY)) || {};
		if (enabled) {
			stored[url] = true;
			// Cap the map: drop oldest entries (insertion order)
			const keys = Object.keys(stored);
			for (let i = 0; i < keys.length - MEMORY_CAP; i++) {
				delete stored[keys[i]];
			}
		} else {
			delete stored[url];
		}
		await setLocalStorage(MEMORY_STORAGE_KEY, stored);
	} catch (error) {
		debugLog('FullTranslation', 'Failed to persist memory:', error);
	}
}

export async function wasFullTranslationEnabled(rawUrl: string): Promise<boolean> {
	const url = normalizeMemoryUrl(rawUrl);
	try {
		const stored = (await getLocalStorage(MEMORY_STORAGE_KEY)) || {};
		return stored[url] === true;
	} catch {
		return false;
	}
}

// --- Reader nav button ----------------------------------------------------

export function createFullTranslationNavButton(
	doc: Document,
	getOpts: () => FullTranslationOptions
): HTMLButtonElement {
	const btn = doc.createElement('button');
	btn.className = `nav-btn ${FULL_TRANSLATION_NAV_BUTTON_CLASS}`;
	btn.setAttribute('aria-label', getMessage('translateFullArticle'));
	const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('width', '18');
	svg.setAttribute('height', '18');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', '1.75');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	for (const d of ['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6']) {
		const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	btn.appendChild(svg);
	btn.addEventListener('click', () => {
		const on = toggleFullTranslation(doc, getOpts());
		btn.classList.toggle('is-active', on);
	});
	return btn;
}
