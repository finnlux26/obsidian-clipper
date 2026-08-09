// Reader translation UI (fork issue #3): a floating "Translate" button next
// to the existing highlight affordance, and a popover that shows the
// context-aware translation of the selection: word/phrase popovers with
// phonetics, and passage translation with insert-as-comparison (issue #6).
import browser from './browser-polyfill';
import { generalSettings } from './storage-utils';
import { getMessage } from './i18n';
import { setElementHTML } from './dom-utils';
import {
	ArticleMeta,
	SelectionContext,
	extractSelectionContext
} from './translator-context';
import {
	PassageTranslation,
	TranslationUnavailableError,
	WordTranslation,
	translatePassage,
	translateSelection
} from './translator';
import { PhoneticsResult, isEnglishWord, lookupPhonetics } from './dictionary';

const POPOVER_CLASS = 'obsidian-translate-popover';
const BUTTON_CLASS = 'obsidian-selection-translate';
const TRANSLATION_NODE_CLASS = 'obsidian-reader-translation';

// Passage selections longer than this get a "split it up" hint instead of a
// silently truncated (and mischarged) request
const MAX_PASSAGE_CHARS = 3000;

// Stable content hash for comparison nodes (djb2, hex)
export function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(16);
}

// Blocks whose siblings carry structural meaning (list numbering, table
// layout) get the comparison appended inside instead of beside them
const APPEND_INSIDE_TAGS = new Set(['LI', 'TD', 'TH', 'DD', 'DT']);

// Insert the translated paragraph as a comparison node. The original block
// node is never modified — highlight anchors must survive. Idempotent per
// source-paragraph hash.
export function insertComparisonNode(doc: Document, ctx: SelectionContext, translation: string, targetLanguage: string): HTMLElement | null {
	const block = ctx.blockElement;
	if (!block || !doc.contains(block)) return null;
	// Language-scoped hash: switching target languages inserts a separate
	// comparison instead of silently reusing the old one
	const hash = hashText(targetLanguage + '\u0000' + ctx.paragraph);

	const appendInside = APPEND_INSIDE_TAGS.has(block.tagName);
	const existing = appendInside
		? block.querySelector(`:scope > .${TRANSLATION_NODE_CLASS}[data-src-hash="${hash}"]`)
		: block.nextElementSibling?.matches(`.${TRANSLATION_NODE_CLASS}[data-src-hash="${hash}"]`)
			? block.nextElementSibling
			: null;
	if (existing) return existing as HTMLElement;

	const node = doc.createElement(appendInside ? 'div' : (block.tagName === 'P' ? 'p' : 'div'));
	node.className = TRANSLATION_NODE_CLASS;
	node.setAttribute('data-src-hash', hash);
	node.textContent = translation;
	if (appendInside) {
		block.appendChild(node);
	} else {
		block.after(node);
	}
	return node;
}

// data-state drives both styling and (later) E2E waits: pending | done | error
type PopoverState = 'pending' | 'done' | 'error';

function setState(popover: HTMLElement, state: PopoverState) {
	popover.setAttribute('data-state', state);
}

function getTargetLanguage(): string {
	// Stored override first (no settings UI yet — a later ticket adds it),
	// then the extension UI language, then the browser language
	const override = generalSettings.readerSettings?.translationTargetLanguage;
	if (override) return override;
	const uiLanguage = (browser.i18n as { getUILanguage?: () => string }).getUILanguage?.();
	return uiLanguage || navigator.language || 'en';
}

function articleMetaFromDocument(doc: Document): ArticleMeta {
	const heading = doc.querySelector('.obsidian-reader-content article h1');
	return {
		title: heading?.textContent?.trim() || doc.title || '',
		site: doc.location?.hostname || '',
		lang: doc.documentElement.lang || ''
	};
}

function closePopover(doc: Document) {
	doc.querySelector(`.${POPOVER_CLASS}`)?.remove();
}

// Phonetics row: dictionary data wins; an LLM-provided IPA is only shown as
// an approximation when the dictionary missed. Returns null when neither is
// available so the row simply doesn't appear.
function buildPhoneticsRow(doc: Document, dict: PhoneticsResult | null, llmIpa?: string): HTMLElement | null {
	const hasDict = !!(dict && (dict.uk || dict.us));
	if (!hasDict && !llmIpa) return null;

	const row = doc.createElement('div');
	row.className = 'obsidian-translate-phonetics';

	if (hasDict) {
		const regions: Array<{ label: string; pron?: { ipa?: string; audioUrl?: string } }> = [
			{ label: 'UK', pron: dict!.uk },
			{ label: 'US', pron: dict!.us }
		];
		for (const { label, pron } of regions) {
			if (!pron || (!pron.ipa && !pron.audioUrl)) continue;
			const item = doc.createElement('span');
			item.className = 'obsidian-translate-phonetic';
			const region = doc.createElement('span');
			region.className = 'obsidian-translate-phonetic-region';
			region.textContent = label;
			item.appendChild(region);
			if (pron.ipa) {
				const ipa = doc.createElement('span');
				ipa.textContent = pron.ipa;
				item.appendChild(ipa);
			}
			if (pron.audioUrl) {
				const play = doc.createElement('button');
				play.type = 'button';
				play.className = 'obsidian-translate-audio';
				play.setAttribute('aria-label', getMessage('translationPlayAudio'));
				setElementHTML(play, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>');
				const url = pron.audioUrl;
				play.addEventListener('click', (e) => {
					e.stopPropagation();
					const win = doc.defaultView || window;
					new win.Audio(url).play().catch(() => {});
				});
				item.appendChild(play);
			}
			row.appendChild(item);
		}
	} else if (llmIpa) {
		const item = doc.createElement('span');
		item.className = 'obsidian-translate-phonetic';
		item.textContent = llmIpa;
		const approx = doc.createElement('span');
		approx.className = 'obsidian-translate-phonetic-approx';
		approx.textContent = `(${getMessage('translationPhoneticsApprox')})`;
		row.appendChild(item);
		row.appendChild(approx);
	}

	return row.childElementCount > 0 ? row : null;
}

function renderResult(doc: Document, popover: HTMLElement, result: WordTranslation) {
	const body = popover.querySelector('.obsidian-translate-body') as HTMLElement;
	body.textContent = '';

	const main = doc.createElement('div');
	main.className = 'obsidian-translate-main';
	if (result.partOfSpeech) {
		const pos = doc.createElement('span');
		pos.className = 'obsidian-translate-pos';
		pos.textContent = result.partOfSpeech;
		main.appendChild(pos);
	}
	const translation = doc.createElement('span');
	translation.className = 'obsidian-translate-result';
	translation.textContent = result.translation;
	main.appendChild(translation);
	body.appendChild(main);

	if (result.meaningInContext) {
		const meaning = doc.createElement('div');
		meaning.className = 'obsidian-translate-meaning';
		meaning.textContent = result.meaningInContext;
		body.appendChild(meaning);
	}

	if (result.degraded) {
		const hint = doc.createElement('div');
		hint.className = 'obsidian-translate-degraded';
		hint.textContent = getMessage('translationDegraded');
		body.appendChild(hint);
	}

	const others = (result.otherCommonMeanings || []).filter(Boolean);
	if (others.length > 0) {
		const row = doc.createElement('div');
		row.className = 'obsidian-translate-others';
		const label = doc.createElement('span');
		label.className = 'obsidian-translate-others-label';
		label.textContent = getMessage('translationOtherMeanings');
		row.appendChild(label);
		for (const meaning of others) {
			const chip = doc.createElement('span');
			chip.className = 'obsidian-translate-other';
			chip.textContent = meaning;
			row.appendChild(chip);
		}
		body.appendChild(row);
	}

	setState(popover, 'done');
}

function renderPassageResult(
	doc: Document,
	popover: HTMLElement,
	ctx: SelectionContext,
	result: PassageTranslation,
	targetLanguage: string
) {
	const body = popover.querySelector('.obsidian-translate-body') as HTMLElement;
	body.textContent = '';

	const text = doc.createElement('div');
	text.className = 'obsidian-translate-passage';
	text.textContent = result.translation;
	body.appendChild(text);

	if (ctx.blockElement) {
		const insert = doc.createElement('button');
		insert.type = 'button';
		insert.className = 'obsidian-translate-insert';
		insert.textContent = getMessage('translationInsert');
		insert.addEventListener('click', () => {
			const node = insertComparisonNode(doc, ctx, result.translation, targetLanguage);
			if (node) {
				insert.textContent = getMessage('translationInserted');
				insert.disabled = true;
			}
		});
		body.appendChild(insert);
	}

	setState(popover, 'done');
}

function renderError(popover: HTMLElement, error: unknown) {
	const body = popover.querySelector('.obsidian-translate-body') as HTMLElement;
	body.textContent = error instanceof TranslationUnavailableError
		? getMessage('translationNoEngine')
		: getMessage('translationFailed');
	setState(popover, 'error');
}

function renderTooLong(popover: HTMLElement) {
	const body = popover.querySelector('.obsidian-translate-body') as HTMLElement;
	body.textContent = getMessage('translationTooLong');
	setState(popover, 'error');
}

export function openTranslationPopover(
	doc: Document,
	ctx: SelectionContext,
	targetLanguage: string,
	anchorRect?: { left: number; bottom: number }
): HTMLElement {
	closePopover(doc);

	const popover = doc.createElement('div');
	popover.className = POPOVER_CLASS;
	popover.setAttribute('role', 'dialog');
	setState(popover, 'pending');

	const header = doc.createElement('div');
	header.className = 'obsidian-translate-header';
	const word = doc.createElement('span');
	word.className = 'obsidian-translate-word';
	word.textContent = ctx.selectedText;
	header.appendChild(word);
	const close = doc.createElement('button');
	close.type = 'button';
	close.className = 'obsidian-translate-close';
	close.setAttribute('aria-label', getMessage('close'));
	close.textContent = '×';
	close.addEventListener('click', () => closePopover(doc));
	header.appendChild(close);
	popover.appendChild(header);

	const body = doc.createElement('div');
	body.className = 'obsidian-translate-body';
	body.textContent = getMessage('translationLoading');
	popover.appendChild(body);

	if (anchorRect) {
		const win = doc.defaultView || window;
		popover.style.left = `${Math.max(4, anchorRect.left) + win.scrollX}px`;
		popover.style.top = `${anchorRect.bottom + win.scrollY + 8}px`;
	}

	doc.body.appendChild(popover);

	// Dismissal: Escape, or any pointer press outside the popover. Listeners
	// clean themselves up so repeated popovers don't accumulate handlers.
	const onKeydown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') dismiss();
	};
	const onPointerDown = (e: Event) => {
		if (!popover.contains(e.target as Node)) dismiss();
	};
	const dismiss = () => {
		doc.removeEventListener('keydown', onKeydown, true);
		doc.removeEventListener('mousedown', onPointerDown, true);
		doc.removeEventListener('touchstart', onPointerDown, true);
		observer.disconnect();
		popover.remove();
	};
	doc.addEventListener('keydown', onKeydown, true);
	doc.addEventListener('mousedown', onPointerDown, true);
	doc.addEventListener('touchstart', onPointerDown, true);
	// Replacing this popover from elsewhere (closePopover) must also drop
	// its listeners — the observer catches removals that bypass dismiss()
	const observer = new MutationObserver(() => {
		if (!doc.contains(popover)) dismiss();
	});
	observer.observe(doc.body, { childList: true });

	if (ctx.kind === 'passage') {
		if (ctx.selectedText.length > MAX_PASSAGE_CHARS) {
			renderTooLong(popover);
			return popover;
		}
		translatePassage(ctx, targetLanguage)
			.then(result => {
				if (doc.contains(popover)) renderPassageResult(doc, popover, ctx, result, targetLanguage);
			})
			.catch(error => {
				console.error('Translation failed:', error);
				if (doc.contains(popover)) renderError(popover, error);
			});
		return popover;
	}

	// Phonetics enrichment runs in parallel with the translation and never
	// blocks it: whichever source resolves first renders first, and the
	// dictionary result replaces an interim LLM approximation.
	let dictPhonetics: PhoneticsResult | null | undefined;
	let llmIpa: string | undefined;
	const renderPhonetics = () => {
		if (!doc.contains(popover)) return;
		popover.querySelector('.obsidian-translate-phonetics')?.remove();
		const row = buildPhoneticsRow(doc, dictPhonetics ?? null, llmIpa);
		if (row) header.after(row);
	};
	if (ctx.kind === 'word' && isEnglishWord(ctx.selectedText)) {
		lookupPhonetics(ctx.selectedText).then(result => {
			dictPhonetics = result;
			renderPhonetics();
		});
	}

	translateSelection(ctx, targetLanguage)
		.then(result => {
			if (!doc.contains(popover)) return;
			renderResult(doc, popover, result);
			if (result.ipa) {
				llmIpa = result.ipa;
				renderPhonetics();
			}
		})
		.catch(error => {
			console.error('Translation failed:', error);
			if (doc.contains(popover)) renderError(popover, error);
		});

	return popover;
}

// Whether the current selection is one the translate affordance handles:
// a word or short phrase inside the reader article. Passages are deferred.
export function shouldOfferTranslation(selection: Selection | null, doc: Document): boolean {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
	const article = doc.querySelector('.obsidian-reader-content article');
	if (!article) return false;
	const range = selection.getRangeAt(0);
	if (!article.contains(range.commonAncestorContainer)) return false;
	const ctx = extractSelectionContext(selection, articleMetaFromDocument(doc));
	return ctx !== null;
}

// Floating "Translate" button that appears next to the highlight button on
// text selection. Mirrors the listener pattern of
// registerSelectionToHighlightButton in reader.ts, which runs first and
// therefore positions its own button before this one reads its width.
export function registerSelectionTranslation(doc: Document, isActive: () => boolean): void {
	if (doc.querySelector(`.${BUTTON_CLASS}`)) return;

	const btn = doc.createElement('button');
	btn.type = 'button';
	btn.className = `obsidian-selection-action ${BUTTON_CLASS}`;
	btn.setAttribute('aria-label', getMessage('translateSelection'));
	setElementHTML(btn, `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span>${getMessage('translateSelection')}</span>`);
	btn.style.display = 'none';
	// Preserve the selection when the pointer goes down on the button
	btn.addEventListener('mousedown', e => e.preventDefault());
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		const sel = doc.getSelection();
		if (!shouldOfferTranslation(sel, doc)) return;
		const ctx = extractSelectionContext(sel!, articleMetaFromDocument(doc));
		if (!ctx) return;
		const range = sel!.getRangeAt(0);
		const rects = range.getClientRects();
		const last = rects.length > 0 ? rects[rects.length - 1] : undefined;
		hide();
		openTranslationPopover(doc, ctx, getTargetLanguage(),
			last ? { left: last.left, bottom: last.bottom } : undefined);
	});
	doc.body.appendChild(btn);

	const hide = () => { btn.style.display = 'none'; };

	const update = () => {
		if (!isActive()) return hide();
		if (doc.body.classList.contains('obsidian-highlighter-active')) return hide();
		const sel = doc.getSelection();
		if (!shouldOfferTranslation(sel, doc)) return hide();
		const range = sel!.getRangeAt(0);
		const rects = range.getClientRects();
		if (rects.length === 0) return hide();
		const last = rects[rects.length - 1];
		btn.style.display = 'flex';
		// Sit to the right of the highlight button, which positioned itself
		// from the same selection just before this listener ran
		const highlightBtn = doc.querySelector(
			`.obsidian-selection-action:not(.${BUTTON_CLASS})`
		) as HTMLElement | null;
		const highlightWidth = highlightBtn && highlightBtn.style.display !== 'none'
			? (highlightBtn.offsetWidth || 90) + 6
			: 0;
		const btnWidth = btn.offsetWidth || 90;
		const idealLeft = last.right + 2 + highlightWidth;
		const clampedLeft = Math.min(idealLeft, window.innerWidth - btnWidth - 4);
		btn.style.left = `${Math.max(4, clampedLeft) + window.scrollX}px`;
		btn.style.top = `${last.bottom + window.scrollY - 6}px`;
	};

	doc.addEventListener('mouseup', () => setTimeout(update, 0));
	doc.addEventListener('keyup', (e) => {
		if (e.shiftKey || e.key === 'Shift') setTimeout(update, 0);
	});
	let selChangeTimer: ReturnType<typeof setTimeout> | null = null;
	doc.addEventListener('selectionchange', () => {
		const sel = doc.getSelection();
		if (!sel || sel.isCollapsed) {
			if (selChangeTimer) { clearTimeout(selChangeTimer); selChangeTimer = null; }
			hide();
		} else {
			if (selChangeTimer) clearTimeout(selChangeTimer);
			selChangeTimer = setTimeout(update, 200);
		}
	});
	window.addEventListener('resize', hide);
}
