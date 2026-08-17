// Translation engine layer (fork issue #3). Minimal first form: a single
// LLM-backed engine that reuses the interpreter's provider/model settings via
// the generic llm-request layer. The TranslationEngine seam exists so the
// browser Translator API engine and dispatch rules (issue #7) can slot in
// without touching callers.
import { generalSettings } from './storage-utils';
import { ModelConfig, Provider } from '../types/types';
import { sendChatRequest } from './llm-request';
import { ArticleMeta, SelectionContext } from './translator-context';
import { debugLog } from './debug';

export interface WordTranslation {
	translation: string;
	partOfSpeech?: string;
	meaningInContext?: string;
	otherCommonMeanings?: string[];
	// LLM-provided IPA, used only when the dictionary source misses (issue #5)
	ipa?: string;
	// Set by the browser engine: a plain whole-sentence translation without
	// word-sense analysis — the UI shows an upgrade hint (issue #7)
	degraded?: boolean;
	// Which engine produced this result, surfaced as a badge in the popover
	engine?: 'llm' | 'browser';
	// Display label for the LLM engine (the configured model's name)
	engineLabel?: string;
}

export interface TranslateWordRequest {
	ctx: SelectionContext;
	targetLanguage: string;
}

export interface PassageTranslation {
	translation: string;
	engine?: 'llm' | 'browser';
	engineLabel?: string;
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

export interface GlossaryEntry {
	source: string;
	target: string;
}

export interface BatchTranslationResult {
	// Aligned with the input paragraphs; undefined = the model skipped it
	translations: Array<string | undefined>;
	keyTerms: GlossaryEntry[];
}

const BATCH_SYSTEM_PROMPT =
	'You are a precise translator embedded in a reading tool. ' +
	'Translate each numbered paragraph into the target language, preserving the numbering. ' +
	'Keep terminology consistent across paragraphs; when a glossary is provided, use those translations verbatim. ' +
	'Respond with a single JSON object only — no markdown fences, no commentary: ' +
	'{"translations": {"1": "...", "2": "..."}, "keyTerms": [{"source": "...", "target": "..."}]}. ' +
	'keyTerms lists up to 8 recurring domain terms from this batch with the translation you used (empty array if none).';

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

// Shared lenient JSON extraction for model replies: strip fences, parse,
// fall back to the first {...} span
function parseModelJson(content: string): any {
	const unfenced = stripCodeFences(content);
	try {
		return JSON.parse(unfenced);
	} catch {
		const match = unfenced.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new Error('The model returned a response that could not be parsed.');
		}
		return JSON.parse(match[0]);
	}
}

function parseWordTranslation(content: string): WordTranslation {
	const parsed = parseModelJson(content);
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
	const parsed = parseModelJson(content);
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
		return { ...parseWordTranslation(content), engine: 'llm' as const, engineLabel: target.model.name };
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
		return { ...parsePassageTranslation(content), engine: 'llm' as const, engineLabel: target.model.name };
	}
}

// Chrome 138+ built-in Translator API — the typings aren't in the project's
// lib target, so the global gets a minimal local shape
interface BrowserTranslatorInstance {
	translate(text: string): Promise<string>;
}
interface BrowserTranslatorGlobal {
	availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
	create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslatorInstance>;
}

function getBrowserTranslatorGlobal(): BrowserTranslatorGlobal | undefined {
	return (globalThis as { Translator?: BrowserTranslatorGlobal }).Translator;
}

function primaryLanguage(tag: string): string {
	return (tag || '').split('-')[0].toLowerCase();
}

// Direct translation without word-sense analysis: words get their whole
// sentence translated (degraded mode with an upgrade hint), passages get a
// plain translation. Local, free, no context awareness.
class BrowserTranslationEngine implements TranslationEngine {
	id = 'browser' as const;
	private instances = new Map<string, Promise<BrowserTranslatorInstance>>();

	clearInstances(): void {
		this.instances.clear();
	}

	async available(): Promise<boolean> {
		return !!getBrowserTranslatorGlobal();
	}

	private instance(sourceLanguage: string, targetLanguage: string): Promise<BrowserTranslatorInstance> {
		const key = `${sourceLanguage}>${targetLanguage}`;
		let pending = this.instances.get(key);
		if (!pending) {
			pending = (async () => {
				const api = getBrowserTranslatorGlobal();
				if (!api) {
					throw new TranslationUnavailableError('No translation engine is configured.');
				}
				const availability = await api.availability({ sourceLanguage, targetLanguage });
				if (availability === 'unavailable') {
					throw new Error(`Translation from ${sourceLanguage} to ${targetLanguage} is not available in this browser.`);
				}
				// 'downloadable'/'downloading': create() triggers/awaits the model download
				return api.create({ sourceLanguage, targetLanguage });
			})();
			this.instances.set(key, pending);
			pending.catch(() => this.instances.delete(key));
		}
		return pending;
	}

	private languagesFor(request: TranslateWordRequest): { source: string; target: string } {
		const target = primaryLanguage(request.targetLanguage);
		if (!target) {
			throw new TranslationUnavailableError('No target language configured.');
		}
		return {
			source: primaryLanguage(request.ctx.article.lang) || 'en',
			target
		};
	}

	async translateWord(request: TranslateWordRequest): Promise<WordTranslation> {
		const { source, target } = this.languagesFor(request);
		const sentence = request.ctx.sentence;
		if (source === target) return { translation: sentence, degraded: true, engine: 'browser' as const };
		const translator = await this.instance(source, target);
		return { translation: await translator.translate(sentence), degraded: true, engine: 'browser' as const };
	}

	async translatePassage(request: TranslateWordRequest): Promise<PassageTranslation> {
		const { source, target } = this.languagesFor(request);
		const text = request.ctx.selectedText;
		if (source === target) return { translation: text, engine: 'browser' as const };
		const translator = await this.instance(source, target);
		return { translation: await translator.translate(text), engine: 'browser' as const };
	}

	async translateText(text: string, articleLang: string, targetLanguage: string): Promise<string> {
		const target = primaryLanguage(targetLanguage);
		if (!target) {
			throw new TranslationUnavailableError('No target language configured.');
		}
		const source = primaryLanguage(articleLang) || 'en';
		if (source === target) return text;
		const translator = await this.instance(source, target);
		return translator.translate(text);
	}
}

// Batch translation for the full-article mode (LLM path). Kept outside the
// TranslationEngine interface: batching, numbering and the glossary protocol
// are full-article concerns, not per-selection ones.
export async function translateBatchLlm(
	paragraphs: string[],
	targetLanguage: string,
	article: ArticleMeta,
	glossary: GlossaryEntry[]
): Promise<BatchTranslationResult> {
	const target = resolveLlmTarget();
	if (!target) {
		throw new TranslationUnavailableError('No translation engine is configured.');
	}

	const lines = [
		`Article: "${article.title}" (${article.site}, ${article.lang || 'unknown language'})`,
		`Target language: ${targetLanguage}`
	];
	if (glossary.length > 0) {
		lines.push('Glossary (use these translations verbatim):');
		for (const term of glossary) {
			lines.push(`- ${term.source} → ${term.target}`);
		}
	}
	const context = lines.join('\n');
	const payload = paragraphs.map((text, i) => `[${i + 1}] ${text}`).join('\n\n');

	const content = await sendChatRequest(target.provider, target.model, {
		system: BATCH_SYSTEM_PROMPT,
		context,
		payload
	});

	const parsed = parseModelJson(content);
	const rawTranslations = parsed?.translations;
	if (!rawTranslations || typeof rawTranslations !== 'object') {
		throw new Error('The model response did not contain translations.');
	}
	const translations = paragraphs.map((_, i) => {
		const value = rawTranslations[String(i + 1)];
		return typeof value === 'string' && value ? value : undefined;
	});
	const keyTerms: GlossaryEntry[] = Array.isArray(parsed.keyTerms)
		? parsed.keyTerms.filter((t: any) => t && typeof t.source === 'string' && typeof t.target === 'string')
		: [];
	return { translations, keyTerms };
}

// Direct text translation via the browser engine, for the full-article mode
// (local, free, per-block; no batching or glossary needed)
export function browserTranslateText(text: string, articleLang: string, targetLanguage: string): Promise<string> {
	return browserEngine.translateText(text, articleLang, targetLanguage);
}

export function hasBrowserTranslator(): boolean {
	return !!getBrowserTranslatorGlobal();
}

export function hasLlmEngine(): boolean {
	return resolveLlmTarget() !== null;
}

// Full-article engine preference is reversed from selection dispatch: the
// local browser engine wins on throughput/cost; the LLM is the fallback.
export function getFullTextEngineKind(): 'browser' | 'llm' | null {
	if (getBrowserTranslatorGlobal()) return 'browser';
	if (resolveLlmTarget()) return 'llm';
	return null;
}

const llmEngine = new LlmTranslationEngine();
const browserEngine = new BrowserTranslationEngine();

// Dispatch: context-aware LLM first; browser Translator API as the direct-
// translation fallback; null when neither exists (UI shows the configure
// hint). Synchronous so cache keys can include the engine id.
export function getTranslationEngine(): TranslationEngine | null {
	if (resolveLlmTarget()) return llmEngine;
	if (getBrowserTranslatorGlobal()) return browserEngine;
	return null;
}

// Caching the promise (not the value) also deduplicates in-flight requests:
// re-selecting the same word while the first request is pending must not
// fire a second network call. Failed promises are evicted so an error never
// poisons the cache.
const translationCache = new Map<string, Promise<WordTranslation>>();

export function clearTranslationCache(): void {
	translationCache.clear();
	passageCache.clear();
	browserEngine.clearInstances();
}

export function translateSelection(ctx: SelectionContext, targetLanguage: string): Promise<WordTranslation> {
	const engine = getTranslationEngine();
	if (!engine) {
		return Promise.reject(new TranslationUnavailableError('No translation engine is configured.'));
	}

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
	if (!engine) {
		return Promise.reject(new TranslationUnavailableError('No translation engine is configured.'));
	}

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
