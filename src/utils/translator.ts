// Translation engine layer (fork issue #3). Minimal first form: a single
// LLM-backed engine that reuses the interpreter's provider/model settings via
// the generic llm-request layer. The TranslationEngine seam exists so the
// browser Translator API engine and dispatch rules (issue #7) can slot in
// without touching callers.
import { generalSettings } from './storage-utils';
import { ModelConfig, Provider } from '../types/types';
import { sendChatRequest } from './llm-request';
import { SelectionContext } from './translator-context';
import { debugLog } from './debug';

export interface WordTranslation {
	translation: string;
	partOfSpeech?: string;
	meaningInContext?: string;
	otherCommonMeanings?: string[];
	// LLM-provided IPA, used only when the dictionary source misses (issue #5)
	ipa?: string;
}

export interface TranslateWordRequest {
	ctx: SelectionContext;
	targetLanguage: string;
}

export interface PassageTranslation {
	translation: string;
}

// The engine could not run at all (nothing configured). UI shows an
// actionable "configure the Interpreter" message for this one.
export class TranslationUnavailableError extends Error {}

export interface TranslationEngine {
	id: 'browser' | 'llm';
	available(): Promise<boolean>;
	translateWord(request: TranslateWordRequest): Promise<WordTranslation>;
	translatePassage(request: TranslateWordRequest): Promise<PassageTranslation>;
}

interface LlmTarget {
	provider: Provider;
	model: ModelConfig;
}

function resolveLlmTarget(): LlmTarget | null {
	if (!generalSettings.interpreterEnabled) return null;
	const models = generalSettings.models.filter(m => m.enabled);
	const model = models.find(m => m.id === generalSettings.interpreterModel) ?? models[0];
	if (!model) return null;
	const provider = generalSettings.providers.find(p => p.id === model.providerId);
	if (!provider) return null;
	if (provider.apiKeyRequired && !provider.apiKey) return null;
	return { provider, model };
}

const WORD_SYSTEM_PROMPT =
	'You are a precise translation assistant embedded in a reading tool. ' +
	'Respond with a single JSON object only — no markdown fences, no commentary. Keys: ' +
	'"translation" (best translation of the selected text into the target language, as used in this exact sentence), ' +
	'"partOfSpeech" (short English label like "noun" or "verb", empty string if not applicable), ' +
	'"meaningInContext" (one short sentence in the target language explaining what the selection means in this sentence), ' +
	'"otherCommonMeanings" (array of up to 3 other common translations, empty array if none), ' +
	'"ipa" (IPA transcription of the selection if you are confident it is correct, empty string otherwise).';

const PASSAGE_SYSTEM_PROMPT =
	'You are a precise translator embedded in a reading tool. ' +
	'Translate ONLY the content between <text> and </text> into the target language. ' +
	'The neighboring paragraphs are reference context for pronouns and terminology — do NOT translate them and do NOT include them in your output. ' +
	'Keep terminology consistent with the context. ' +
	'Respond with a single JSON object only — no markdown fences, no commentary: {"translation": "..."}.';

function stripCodeFences(text: string): string {
	return text
		.replace(/^\s*```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/, '')
		.trim();
}

function parseWordTranslation(content: string): WordTranslation {
	const unfenced = stripCodeFences(content);
	let parsed: any;
	try {
		parsed = JSON.parse(unfenced);
	} catch {
		const match = unfenced.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new Error('The model returned a response that could not be parsed.');
		}
		parsed = JSON.parse(match[0]);
	}
	if (!parsed || typeof parsed.translation !== 'string' || !parsed.translation) {
		throw new Error('The model response did not contain a translation.');
	}
	return {
		translation: parsed.translation,
		partOfSpeech: typeof parsed.partOfSpeech === 'string' ? parsed.partOfSpeech : undefined,
		meaningInContext: typeof parsed.meaningInContext === 'string' ? parsed.meaningInContext : undefined,
		otherCommonMeanings: Array.isArray(parsed.otherCommonMeanings)
			? parsed.otherCommonMeanings.filter((m: unknown) => typeof m === 'string')
			: undefined,
		ipa: typeof parsed.ipa === 'string' && parsed.ipa ? parsed.ipa : undefined
	};
}

function parsePassageTranslation(content: string): PassageTranslation {
	const unfenced = stripCodeFences(content);
	let parsed: any;
	try {
		parsed = JSON.parse(unfenced);
	} catch {
		const match = unfenced.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new Error('The model returned a response that could not be parsed.');
		}
		parsed = JSON.parse(match[0]);
	}
	if (!parsed || typeof parsed.translation !== 'string' || !parsed.translation) {
		throw new Error('The model response did not contain a translation.');
	}
	return { translation: parsed.translation };
}

class LlmTranslationEngine implements TranslationEngine {
	id = 'llm' as const;

	async available(): Promise<boolean> {
		return resolveLlmTarget() !== null;
	}

	async translateWord(request: TranslateWordRequest): Promise<WordTranslation> {
		const target = resolveLlmTarget();
		if (!target) {
			throw new TranslationUnavailableError('No translation engine is configured.');
		}
		const { ctx, targetLanguage } = request;

		// Word-level context budget: sentence + article metadata only —
		// deliberately not the paragraph (see spec issue #1)
		const context =
			`Article: "${ctx.article.title}" (${ctx.article.site}, ${ctx.article.lang || 'unknown language'})\n` +
			`Sentence: "${ctx.sentence}"`;
		const payload = JSON.stringify({
			selection: ctx.selectedText,
			targetLanguage
		});

		const content = await sendChatRequest(target.provider, target.model, {
			system: WORD_SYSTEM_PROMPT,
			context,
			payload
		});
		return parseWordTranslation(content);
	}

	async translatePassage(request: TranslateWordRequest): Promise<PassageTranslation> {
		const target = resolveLlmTarget();
		if (!target) {
			throw new TranslationUnavailableError('No translation engine is configured.');
		}
		const { ctx, targetLanguage } = request;

		// Passage context budget: ±1 neighboring paragraph, already truncated
		// at extraction time (see spec issue #1)
		const lines = [`Article: "${ctx.article.title}" (${ctx.article.site}, ${ctx.article.lang || 'unknown language'})`];
		if (ctx.neighbors.before) {
			lines.push(`Previous paragraph (reference only, do not translate): "${ctx.neighbors.before}"`);
		}
		if (ctx.neighbors.after) {
			lines.push(`Next paragraph (reference only, do not translate): "${ctx.neighbors.after}"`);
		}
		lines.push(`Target language: ${targetLanguage}`);
		const context = lines.join('\n');
		const payload = `<text>\n${ctx.selectedText}\n</text>`;

		const content = await sendChatRequest(target.provider, target.model, {
			system: PASSAGE_SYSTEM_PROMPT,
			context,
			payload
		});
		return parsePassageTranslation(content);
	}
}

const llmEngine = new LlmTranslationEngine();

export function getTranslationEngine(): TranslationEngine {
	return llmEngine;
}

// Caching the promise (not the value) also deduplicates in-flight requests:
// re-selecting the same word while the first request is pending must not
// fire a second network call. Failed promises are evicted so an error never
// poisons the cache.
const translationCache = new Map<string, Promise<WordTranslation>>();

export function clearTranslationCache(): void {
	translationCache.clear();
	passageCache.clear();
}

export function translateSelection(ctx: SelectionContext, targetLanguage: string): Promise<WordTranslation> {
	const engine = getTranslationEngine();

	const cacheKey = [engine.id, targetLanguage, ctx.sentence, ctx.selectedText].join('\u0000');
	const cached = translationCache.get(cacheKey);
	if (cached) {
		debugLog('Translator', 'Cache hit for', ctx.selectedText);
		return cached;
	}

	const pending = (async () => {
		if (!(await engine.available())) {
			throw new TranslationUnavailableError('No translation engine is configured.');
		}
		return engine.translateWord({ ctx, targetLanguage });
	})();
	translationCache.set(cacheKey, pending);
	pending.catch(() => translationCache.delete(cacheKey));
	return pending;
}

const passageCache = new Map<string, Promise<PassageTranslation>>();

export function translatePassage(ctx: SelectionContext, targetLanguage: string): Promise<PassageTranslation> {
	const engine = getTranslationEngine();

	const cacheKey = [engine.id, targetLanguage, 'passage', ctx.selectedText].join('\u0000');
	const cached = passageCache.get(cacheKey);
	if (cached) {
		debugLog('Translator', 'Passage cache hit');
		return cached;
	}

	const pending = (async () => {
		if (!(await engine.available())) {
			throw new TranslationUnavailableError('No translation engine is configured.');
		}
		return engine.translatePassage({ ctx, targetLanguage });
	})();
	passageCache.set(cacheKey, pending);
	pending.catch(() => passageCache.delete(cacheKey));
	return pending;
}
