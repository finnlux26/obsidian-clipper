// @vitest-environment jsdom
// Translation engine layer (fork issue #3), tested at the fetchProxy seam:
// the observable behavior is the request that leaves the extension and the
// structured translation that comes back. No internal mocking.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { translateSelection, TranslationUnavailableError, clearTranslationCache } from './translator';
import { generalSettings } from './storage-utils';
import { SelectionContext } from './translator-context';

const CTX: SelectionContext = {
	selectedText: 'bank',
	kind: 'word',
	sentence: 'The bank raised interest rates yesterday.',
	paragraph: 'Money moves fast. The bank raised interest rates yesterday.',
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

		expect(result).toEqual(WORD_RESULT);
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

		expect(a).toEqual(WORD_RESULT);
		expect(b).toEqual(WORD_RESULT);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	test('a different target language misses the cache', async () => {
		proxyRepliesWith(JSON.stringify(WORD_RESULT));

		await translateSelection(CTX, 'zh');
		await translateSelection(CTX, 'ja');

		expect(sendMessage).toHaveBeenCalledTimes(2);
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
