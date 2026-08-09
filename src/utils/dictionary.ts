// Phonetics data source (fork issue #5). IPA and pronunciation audio come
// from a dictionary API rather than the LLM — model-generated IPA
// hallucinates on rare words and can't provide audio. Lookups go through the
// background fetchProxy, are cached by normalized word form, and are gated
// by a privacy setting since the selected word leaves the browser.
import browser from './browser-polyfill';
import { generalSettings } from './storage-utils';
import { debugLog } from './debug';

const DEFAULT_BASE_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

export interface Pronunciation {
	ipa?: string;
	audioUrl?: string;
}

export interface PhoneticsResult {
	uk?: Pronunciation;
	us?: Pronunciation;
}

const ENGLISH_WORD = /^[A-Za-z][A-Za-z''-]*$/;

export function isEnglishWord(text: string): boolean {
	return ENGLISH_WORD.test(text.trim());
}

function stripPunctuation(word: string): string {
	return word.trim().replace(/^[^A-Za-z]+|[^A-Za-z''-]+$/g, '');
}

// Ordered lookup candidates: the word as-is, then progressively reduced
// forms ("running" → "run"). Cheap suffix heuristics, not a real lemmatizer —
// a miss just means no phonetics row.
function normalizationCandidates(word: string): string[] {
	const base = stripPunctuation(word).toLowerCase();
	if (!base) return [];
	const candidates = [base];
	const push = (w: string) => {
		// Derived forms shorter than 3 chars produce embarrassing false hits
		// ("pied" → "pi"), so they are not worth querying
		if (w.length >= 3 && !candidates.includes(w)) candidates.push(w);
	};

	if (base.endsWith("'s") || base.endsWith('’s')) push(base.slice(0, -2));
	if (base.endsWith('ies')) push(base.slice(0, -3) + 'y');
	if (base.endsWith('es')) push(base.slice(0, -2));
	if (base.endsWith('s')) push(base.slice(0, -1));
	if (base.endsWith('ing')) {
		const stem = base.slice(0, -3);
		push(stem);
		// doubled consonant: running → run
		if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
			push(stem.slice(0, -1));
		}
		// dropped e: making → make
		push(stem + 'e');
	}
	if (base.endsWith('ed')) {
		const stem = base.slice(0, -2);
		push(stem);
		push(stem + 'e');
		if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
			push(stem.slice(0, -1));
		}
	}
	return candidates;
}

interface DictionaryPhonetic {
	text?: string;
	audio?: string;
}

function mapPhonetics(entries: unknown): PhoneticsResult | null {
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const phonetics: DictionaryPhonetic[] = entries
		.flatMap((entry: any) => Array.isArray(entry?.phonetics) ? entry.phonetics : [])
		.filter((p: DictionaryPhonetic) => p && (p.text || p.audio));
	if (phonetics.length === 0) return null;

	const byRegion = (marker: string) =>
		phonetics.find(p => p.audio && p.audio.toLowerCase().includes(marker));
	const fallback = phonetics.find(p => p.text);

	const toPronunciation = (p: DictionaryPhonetic | undefined): Pronunciation | undefined => {
		if (!p) return undefined;
		const pron: Pronunciation = {};
		if (p.text) pron.ipa = p.text;
		if (p.audio) pron.audioUrl = p.audio;
		return pron.ipa || pron.audioUrl ? pron : undefined;
	};

	const uk = toPronunciation(byRegion('-uk') || fallback);
	const us = toPronunciation(byRegion('-us') || fallback);
	if (!uk && !us) return null;
	return { ...(uk ? { uk } : {}), ...(us ? { us } : {}) };
}

async function fetchEntry(baseUrl: string, word: string): Promise<PhoneticsResult | null> {
	const result = await browser.runtime.sendMessage({
		action: 'fetchProxy',
		url: baseUrl + encodeURIComponent(word),
		options: {}
	}) as { ok?: boolean; status?: number; text?: string; error?: string } | undefined;

	if (!result || !result.ok || !result.text) return null;
	try {
		return mapPhonetics(JSON.parse(result.text));
	} catch {
		return null;
	}
}

const phoneticsCache = new Map<string, Promise<PhoneticsResult | null>>();

export function clearPhoneticsCache(): void {
	phoneticsCache.clear();
}

// Resolves to null (never rejects) when disabled, non-English, or not found —
// the phonetics row is an optional enrichment and must not block translation.
export function lookupPhonetics(word: string): Promise<PhoneticsResult | null> {
	if (generalSettings.readerSettings?.dictionaryLookupEnabled === false) {
		return Promise.resolve(null);
	}
	if (!isEnglishWord(stripPunctuation(word))) {
		return Promise.resolve(null);
	}

	const candidates = normalizationCandidates(word);
	if (candidates.length === 0) return Promise.resolve(null);

	const cacheKey = candidates[0];
	const cached = phoneticsCache.get(cacheKey);
	if (cached) return cached;

	const baseUrl = generalSettings.readerSettings?.dictionaryBaseUrl || DEFAULT_BASE_URL;
	const pending = (async () => {
		for (const candidate of candidates) {
			try {
				const result = await fetchEntry(baseUrl, candidate);
				if (result) {
					// Alias the reduced form that actually hit, so "run"
					// selected later reuses the "running" lookup
					if (candidate !== cacheKey) {
						phoneticsCache.set(candidate, Promise.resolve(result));
					}
					return result;
				}
			} catch (error) {
				debugLog('Dictionary', 'Lookup failed for', candidate, error);
			}
		}
		// A miss may be transient (network down); don't pin null forever
		phoneticsCache.delete(cacheKey);
		return null;
	})();
	phoneticsCache.set(cacheKey, pending);
	return pending;
}
