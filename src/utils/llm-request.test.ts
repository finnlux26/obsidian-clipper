// @vitest-environment jsdom
// The generic LLM request layer (fork issue #2): request construction is
// pure, and sending is routed through the background fetchProxy so extension
// pages never fetch LLM endpoints directly (CORS / Private Network Access).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { buildChatRequest, sendChatRequest } from './llm-request';
import { ModelConfig, Provider } from '../types/types';

const SYSTEM = 'You are a helpful translator.';
const CONTEXT = 'Sentence: "the bank raised interest rates"';
const PAYLOAD = '{"prompts":{"prompt_1":"Translate bank"}}';

const anthropic: Provider = {
	id: 'anthropic',
	name: 'Anthropic',
	baseUrl: 'https://api.anthropic.com/v1/messages',
	apiKey: 'key-a'
};
const openai: Provider = {
	id: 'openai',
	name: 'OpenAI',
	baseUrl: 'https://api.openai.com/v1/chat/completions',
	apiKey: 'key-o'
};
const ollama: Provider = {
	id: 'ollama',
	name: 'Ollama',
	apiKey: '',
	baseUrl: 'http://127.0.0.1:11434/api/chat',
	apiKeyRequired: false
};

function model(provider: Provider, providerModelId: string): ModelConfig {
	return { id: 'm', providerId: provider.id, providerModelId, name: 'M', enabled: true };
}

describe('buildChatRequest', () => {
	test('anthropic shape: system field, x-api-key header, user messages in order', () => {
		const spec = buildChatRequest(anthropic, model(anthropic, 'claude-sonnet-5'), SYSTEM, CONTEXT, PAYLOAD);
		expect(spec.url).toBe('https://api.anthropic.com/v1/messages');
		expect(spec.headers['x-api-key']).toBe('key-a');
		expect(spec.headers['anthropic-version']).toBe('2023-06-01');
		expect(spec.body).toMatchObject({
			model: 'claude-sonnet-5',
			system: SYSTEM,
			messages: [
				{ role: 'user', content: CONTEXT },
				{ role: 'user', content: PAYLOAD }
			]
		});
	});

	test('openai-compatible default shape: system message first, bearer auth', () => {
		const spec = buildChatRequest(openai, model(openai, 'gpt-5.6-sol'), SYSTEM, CONTEXT, PAYLOAD);
		expect(spec.headers['Authorization']).toBe('Bearer key-o');
		expect(spec.body).toMatchObject({
			model: 'gpt-5.6-sol',
			stream: false,
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: CONTEXT },
				{ role: 'user', content: PAYLOAD }
			]
		});
	});

	test('ollama shape: json format, no auth header', () => {
		const spec = buildChatRequest(ollama, model(ollama, 'llama3.3'), SYSTEM, CONTEXT, PAYLOAD);
		expect(spec.body).toMatchObject({ format: 'json', stream: false });
		expect(spec.headers['Authorization']).toBeUndefined();
	});
});

describe('sendChatRequest', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	beforeEach(() => {
		sendMessage.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function proxyReplies(response: unknown, status = 200, ok = true) {
		sendMessage.mockResolvedValue({ ok, status, text: JSON.stringify(response) });
	}

	test('routes the request through the background fetchProxy', async () => {
		proxyReplies({ content: [{ type: 'text', text: '{"answer":42}' }], stop_reason: 'end_turn' });

		const content = await sendChatRequest(anthropic, model(anthropic, 'claude-sonnet-5'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		});

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const message = sendMessage.mock.calls[0][0] as any;
		expect(message.action).toBe('fetchProxy');
		expect(message.url).toBe('https://api.anthropic.com/v1/messages');
		expect(message.options.method).toBe('POST');
		expect(message.options.headers['x-api-key']).toBe('key-a');
		expect(JSON.parse(message.options.body).model).toBe('claude-sonnet-5');
		// Anthropic envelope unwrapped to its text block
		expect(content).toBe('{"answer":42}');
	});

	test('falls back to direct fetch when the proxy needs a CORS permission grant', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '', error: 'CORS_PERMISSION_NEEDED' });
		const directFetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }] })
		}));
		vi.stubGlobal('fetch', directFetch);

		const content = await sendChatRequest(openai, model(openai, 'gpt-5.6-sol'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		});

		expect(directFetch).toHaveBeenCalledTimes(1);
		expect(content).toBe('hello');
	});

	test('falls back to direct fetch when messaging is unavailable (CLI context)', async () => {
		sendMessage.mockRejectedValue(new Error('No runtime'));
		const directFetch = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: async () => JSON.stringify({ choices: [{ message: { content: 'cli' }, finish_reason: 'stop' }] })
		}));
		vi.stubGlobal('fetch', directFetch);

		const content = await sendChatRequest(openai, model(openai, 'gpt-5.6-sol'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		});

		expect(directFetch).toHaveBeenCalledTimes(1);
		expect(content).toBe('cli');
	});

	test('surfaces the Ollama 403 origin hint', async () => {
		proxyReplies({ error: 'forbidden' }, 403, false);

		await expect(sendChatRequest(ollama, model(ollama, 'llama3.3'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		})).rejects.toThrow(/OLLAMA_ORIGINS/);
	});

	test('rejects when the response was truncated at the token limit', async () => {
		proxyReplies({ choices: [{ message: { content: 'partial…' }, finish_reason: 'length' }] });

		await expect(sendChatRequest(openai, model(openai, 'gpt-5.6-sol'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		})).rejects.toThrow(/token limit/);
	});

	test('rejects with the provider error body on non-ok responses', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 401, text: 'invalid api key' });

		await expect(sendChatRequest(openai, model(openai, 'gpt-5.6-sol'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		})).rejects.toThrow(/OpenAI error: .*invalid api key/);
	});
});
