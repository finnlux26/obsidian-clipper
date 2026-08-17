// @vitest-environment jsdom
// Translation engine layer (fork issue #3), tested at the fetchProxy seam:
// the observable behavior is the request that leaves the extension and the
// structured translation that comes back. No internal mocking.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { translateSelection, translatePassage, translateBatchLlm, TranslationUnavailableError, clearTranslationCache } from './translator';
import { generalSettings } from './storage-utils';
import { SelectionContext } from './translator-context';

const CTX: SelectionContext = {
	selectedText: 'bank',
	kind: 'word',
	sentence: 'The bank raised interest rates yesterday.',
	paragraph: 'Money moves fast. The bank raised interest rates yesterday.',
	neighbors: {},
	article: { title: 'How Banks Work', site: 'example.com', lang: 'en' }
};

const WORD_RESULT = {
	translation: '银行',
	partOfSpeech: 'noun',
	meaningInContext: '此处指金融机构,而非河岸。',
	otherCommonMeanings: ['河岸', '库']
};

function configureLlm() {
	generalSettings.interpreterEnabled = true;
	generalSettings.interpreterModel = 'model-1';
	generalSettings.models = [
		{ id: 'model-1', providerId: 'provider-1', providerModelId: 'claude-haiku-4-5', name: 'Haiku', enabled: true }
	];
	generalSettings.providers = [
		{ id: 'provider-1', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'k' }
	];
}

describe('translateSelection (LLM engine)', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	beforeEach(() => {
		sendMessage.mockReset();
		clearTranslationCache();
		configureLlm();
	});

	function proxyRepliesWith(payloadText: string) {
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({
				content: [{ type: 'text', text: payloadText }],
				stop_reason: 'end_turn'
			})
		});
	}

	test('sends sentence and article context through the proxy and returns the parsed result', async () => {
		proxyRepliesWith(JSON.stringify(WORD_RESULT));

		const result = await translateSelection(CTX, 'zh');

		expect(result).toMatchObject(WORD_RESULT);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		const message = sendMessage.mock.calls[0][0] as any;
		expect(message.action).toBe('fetchProxy');
		const body = JSON.parse(message.options.body);
		const userContent = body.messages.map((m: { content: string }) => m.content).join('\n');
		// Word-level context budget: the sentence and the article title travel
		// with the request; the full paragraph does not
		expect(userContent).toContain(CTX.sentence);
		expect(userContent).toContain(CTX.article.title);
		expect(userContent).toContain('"bank"');
		expect(userContent).toContain('zh');
		expect(userContent).not.toContain('Money moves fast');
	});

	test('passes through an optional LLM-provided IPA (dictionary-miss fallback)', async () => {
		proxyRepliesWith(JSON.stringify({ ...WORD_RESULT, ipa: '/bæŋk/' }));

		const result = await translateSelection(CTX, 'zh');

		expect(result.ipa).toBe('/bæŋk/');
	});

	test('tolerates a markdown-fenced JSON reply', async () => {
		proxyRepliesWith('```json\n' + JSON.stringify(WORD_RESULT) + '\n```');

		const result = await translateSelection(CTX, 'zh');

		expect(result.translation).toBe('银行');
	});

	test('same word in the same sentence hits the cache', async () => {
		proxyRepliesWith(JSON.stringify(WORD_RESULT));

		const first = await translateSelection(CTX, 'zh');
		const second = await translateSelection(CTX, 'zh');

		expect(second).toEqual(first);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	test('concurrent requests for the same selection share one network call', async () => {
		proxyRepliesWith(JSON.stringify(WORD_RESULT));

		const [a, b] = await Promise.all([
			translateSelection(CTX, 'zh'),
			translateSelection(CTX, 'zh')
		]);

		expect(a).toMatchObject(WORD_RESULT);
		expect(b).toMatchObject(WORD_RESULT);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	test('a different target language misses the cache', async () => {
		proxyRepliesWith(JSON.stringify(WORD_RESULT));

		await translateSelection(CTX, 'zh');
		await translateSelection(CTX, 'ja');

		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	test('passage: sends delimited text with do-not-translate neighbors and parses the result', async () => {
		const passageCtx: SelectionContext = {
			selectedText: 'The bank raised rates. Markets fell sharply on the news.',
			kind: 'passage',
			sentence: 'The bank raised rates.',
			paragraph: 'The bank raised rates. Markets fell sharply on the news.',
			neighbors: {
				before: 'Yesterday the central bank met.',
				after: 'Analysts expect more volatility.'
			},
			article: CTX.article
		};
		proxyRepliesWith(JSON.stringify({ translation: '银行加息了。市场应声大跌。' }));

		const result = await translatePassage(passageCtx, 'zh');

		expect(result.translation).toBe('银行加息了。市场应声大跌。');
		const message = sendMessage.mock.calls[0][0] as any;
		const body = JSON.parse(message.options.body);
		const userContent = body.messages.map((m: { content: string }) => m.content).join('\n');
		// The passage travels inside explicit delimiters…
		expect(userContent).toContain('<text>');
		expect(userContent).toContain(passageCtx.selectedText);
		// …and both neighbors are labeled as reference-only
		expect(userContent).toContain('Yesterday the central bank met.');
		expect(userContent).toContain('Analysts expect more volatility.');
		expect(body.system).toMatch(/do NOT translate/i);
	});

	test('passage translations are cached like word translations', async () => {
		const passageCtx: SelectionContext = {
			...CTX,
			selectedText: 'A long passage of text here.',
			kind: 'passage',
			neighbors: {}
		};
		proxyRepliesWith(JSON.stringify({ translation: '一段长文。' }));

		await translatePassage(passageCtx, 'zh');
		await translatePassage(passageCtx, 'zh');

		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	test('throws TranslationUnavailableError when the interpreter is not configured', async () => {
		generalSettings.interpreterEnabled = false;

		await expect(translateSelection(CTX, 'zh')).rejects.toBeInstanceOf(TranslationUnavailableError);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('throws TranslationUnavailableError when the provider is missing its API key', async () => {
		generalSettings.providers[0] = { ...generalSettings.providers[0], apiKey: '', apiKeyRequired: true };

		await expect(translateSelection(CTX, 'zh')).rejects.toBeInstanceOf(TranslationUnavailableError);
	});

	test('rejects on an unparseable model reply and does not poison the cache', async () => {
		proxyRepliesWith('Sorry, I cannot help with that.');

		await expect(translateSelection(CTX, 'zh')).rejects.toThrow();

		proxyRepliesWith(JSON.stringify(WORD_RESULT));
		const retry = await translateSelection(CTX, 'zh');
		expect(retry.translation).toBe('银行');
	});
});

describe('translateBatchLlm (full-article batches)', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');
	const ARTICLE = CTX.article;

	beforeEach(() => {
		sendMessage.mockReset();
		clearTranslationCache();
		configureLlm();
	});

	function proxyRepliesWith(payloadText: string) {
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({
				content: [{ type: 'text', text: payloadText }],
				stop_reason: 'end_turn'
			})
		});
	}

	test('numbered paragraphs go out, translations come back aligned by number', async () => {
		proxyRepliesWith(JSON.stringify({
			translations: { '1': '第一段。', '2': '第二段。' },
			keyTerms: [{ source: 'interest rate', target: '利率' }]
		}));

		const result = await translateBatchLlm(
			['First paragraph.', 'Second paragraph.'],
			'zh', ARTICLE, []
		);

		expect(result.translations).toEqual(['第一段。', '第二段。']);
		expect(result.keyTerms).toEqual([{ source: 'interest rate', target: '利率' }]);
		const body = JSON.parse((sendMessage.mock.calls[0][0] as any).options.body);
		const userContent = body.messages.map((m: { content: string }) => m.content).join('\n');
		expect(userContent).toContain('[1] First paragraph.');
		expect(userContent).toContain('[2] Second paragraph.');
	});

	test('an established glossary is injected into the prompt', async () => {
		proxyRepliesWith(JSON.stringify({ translations: { '1': 'x' } }));

		await translateBatchLlm(['Text about transformers.'], 'zh', ARTICLE, [
			{ source: 'transformer', target: '变换器' }
		]);

		const body = JSON.parse((sendMessage.mock.calls[0][0] as any).options.body);
		const userContent = body.messages.map((m: { content: string }) => m.content).join('\n');
		expect(userContent).toContain('transformer');
		expect(userContent).toContain('变换器');
	});

	test('missing numbers come back undefined instead of shifting alignment', async () => {
		proxyRepliesWith(JSON.stringify({ translations: { '1': '一', '3': '三' } }));

		const result = await translateBatchLlm(['a', 'b', 'c'], 'zh', ARTICLE, []);

		expect(result.translations).toEqual(['一', undefined, '三']);
	});

	test('a reply without keyTerms yields an empty glossary delta', async () => {
		proxyRepliesWith(JSON.stringify({ translations: { '1': '一' } }));

		const result = await translateBatchLlm(['a'], 'zh', ARTICLE, []);

		expect(result.keyTerms).toEqual([]);
	});
});

describe('engine dispatch (browser Translator API fallback)', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');
	let translateSpy: ReturnType<typeof vi.fn>;
	let availabilitySpy: ReturnType<typeof vi.fn>;

	function stubBrowserTranslator(availability = 'available') {
		translateSpy = vi.fn(async (text: string) => `译:${text}`);
		availabilitySpy = vi.fn(async () => availability);
		(globalThis as any).Translator = {
			availability: availabilitySpy,
			create: vi.fn(async () => ({ translate: translateSpy }))
		};
	}

	beforeEach(() => {
		sendMessage.mockReset();
		clearTranslationCache();
		configureLlm();
	});

	afterEach(() => {
		delete (globalThis as any).Translator;
	});

	test('no LLM configured: word falls back to a degraded whole-sentence translation', async () => {
		generalSettings.interpreterEnabled = false;
		stubBrowserTranslator();

		const result = await translateSelection(CTX, 'zh');

		expect(result.degraded).toBe(true);
		expect(result.translation).toBe(`译:${CTX.sentence}`);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('LLM configured: the LLM wins even when the browser engine exists', async () => {
		stubBrowserTranslator();
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({
				content: [{ type: 'text', text: JSON.stringify(WORD_RESULT) }],
				stop_reason: 'end_turn'
			})
		});

		const result = await translateSelection(CTX, 'zh');

		expect(result.translation).toBe('银行');
		expect(result.degraded).toBeUndefined();
		expect(translateSpy).not.toHaveBeenCalled();
	});

	test('no LLM configured: passages translate directly through the browser engine', async () => {
		generalSettings.interpreterEnabled = false;
		stubBrowserTranslator();
		const passageCtx: SelectionContext = {
			...CTX,
			selectedText: 'The bank raised rates. Markets fell.',
			kind: 'passage'
		};

		const result = await translatePassage(passageCtx, 'zh');

		expect(result.translation).toBe('译:The bank raised rates. Markets fell.');
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('language pair unavailable in the browser engine rejects with a clear error', async () => {
		generalSettings.interpreterEnabled = false;
		stubBrowserTranslator('unavailable');

		await expect(translateSelection(CTX, 'zh')).rejects.toThrow(/not available/i);
	});

	test('neither engine present still raises TranslationUnavailableError', async () => {
		generalSettings.interpreterEnabled = false;

		await expect(translateSelection(CTX, 'zh')).rejects.toBeInstanceOf(TranslationUnavailableError);
	});
});
