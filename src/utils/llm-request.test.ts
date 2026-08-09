// @vitest-environment jsdom
// The generic LLM request layer (fork issue #2): request construction is
// pure, and sending is routed through the background fetchProxy so extension
// pages never fetch LLM endpoints directly (CORS / Private Network Access).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import browser from './browser-polyfill';
import {
	buildChatRequest,
	checkEndpointHealth,
	isLocalEndpoint,
	LocalEndpointUnreachableError,
	sendChatRequest
} from './llm-request';
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
const localProxy: Provider = {
	id: 'local-proxy',
	name: 'Local proxy (OpenAI-compatible)',
	apiKey: '',
	baseUrl: 'http://127.0.0.1:1455/v1/chat/completions',
	apiKeyRequired: false
};

function model(provider: Provider, providerModelId: string): ModelConfig {
	return { id: 'm', providerId: provider.id, providerModelId, name: 'M', enabled: true };
}

describe('buildChatRequest', () => {
	test('anthropic shape: system field, x-api-key header, user messages in order', () => {
		const spec = buildChatRequest(anthropic, model(anthropic, 'claude-sonnet-5'), { system: SYSTEM, context: CONTEXT, payload: PAYLOAD });
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
		const spec = buildChatRequest(openai, model(openai, 'gpt-5.6-sol'), { system: SYSTEM, context: CONTEXT, payload: PAYLOAD });
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
		const spec = buildChatRequest(ollama, model(ollama, 'llama3.3'), { system: SYSTEM, context: CONTEXT, payload: PAYLOAD });
		expect(spec.body).toMatchObject({ format: 'json', stream: false });
		expect(spec.headers['Authorization']).toBeUndefined();
	});

	test('keyless local proxy: default OpenAI shape without an Authorization header', () => {
		const spec = buildChatRequest(localProxy, model(localProxy, 'gpt-5.6-sol'), { system: SYSTEM, context: CONTEXT, payload: PAYLOAD });
		expect(spec.url).toBe('http://127.0.0.1:1455/v1/chat/completions');
		expect(spec.body).toMatchObject({
			model: 'gpt-5.6-sol',
			stream: false,
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: CONTEXT },
				{ role: 'user', content: PAYLOAD }
			]
		});
		// A "Bearer " header with an empty key would be rejected by strict
		// local proxies — it must simply be absent
		expect(spec.headers['Authorization']).toBeUndefined();
	});
});

describe('isLocalEndpoint', () => {
	test.each([
		'http://localhost:1455/v1/chat/completions',
		'http://127.0.0.1:1455/v1/chat/completions',
		'http://[::1]:11434/api/chat',
		'http://0.0.0.0:8080/v1/chat/completions'
	])('%s is local', (url) => {
		expect(isLocalEndpoint(url)).toBe(true);
	});

	test.each([
		'https://api.openai.com/v1/chat/completions',
		'https://localhost.example.com/v1/chat/completions',
		'https://api.anthropic.com/v1/messages',
		'not a url'
	])('%s is not local', (url) => {
		expect(isLocalEndpoint(url)).toBe(false);
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

	function send(provider: Provider) {
		return sendChatRequest(provider, model(provider, 'gpt-5.6-sol'), {
			system: SYSTEM, context: CONTEXT, payload: PAYLOAD
		});
	}

	test('local endpoint: proxy transport error surfaces LocalEndpointUnreachableError with the origin', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '', error: 'Failed to fetch' });

		const failure = await send(localProxy).then(
			() => { throw new Error('expected rejection'); },
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(LocalEndpointUnreachableError);
		expect((failure as LocalEndpointUnreachableError).origin).toBe('http://127.0.0.1:1455');
	});

	test('local endpoint: proxy status 0 without an error string is also unreachable', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '' });

		await expect(send(localProxy)).rejects.toBeInstanceOf(LocalEndpointUnreachableError);
	});

	test('local endpoint: CORS fallback direct fetch rejection becomes LocalEndpointUnreachableError', async () => {
		// The background proxy reports CORS_PERMISSION_NEEDED when its own
		// fetch failed (e.g. connection refused) — the page-level fallback
		// fetch then fails the same way for a dead local endpoint
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '', error: 'CORS_PERMISSION_NEEDED' });
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

		await expect(send(localProxy)).rejects.toBeInstanceOf(LocalEndpointUnreachableError);
	});

	test('local endpoint: direct fetch rejection without a runtime becomes LocalEndpointUnreachableError', async () => {
		sendMessage.mockRejectedValue(new Error('No runtime'));
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

		await expect(send(localProxy)).rejects.toBeInstanceOf(LocalEndpointUnreachableError);
	});

	test('remote endpoint: transport failure keeps its existing error shape', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '', error: 'Failed to fetch' });

		const failure = await send(openai).then(
			() => { throw new Error('expected rejection'); },
			(error: unknown) => error
		);
		expect(failure).not.toBeInstanceOf(LocalEndpointUnreachableError);
		expect((failure as Error).message).toBe('Failed to fetch');
	});

	test('a slow first byte from a local endpoint is not misreported as a timeout', async () => {
		vi.useFakeTimers();
		try {
			sendMessage.mockImplementation(() => new Promise(resolve => {
				setTimeout(() => resolve({
					ok: true,
					status: 200,
					text: JSON.stringify({ choices: [{ message: { content: 'slow but fine' }, finish_reason: 'stop' }] })
				}), 5000);
			}));

			const pending = send(localProxy);
			await vi.advanceTimersByTimeAsync(5000);
			await expect(pending).resolves.toBe('slow but fine');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('checkEndpointHealth', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	beforeEach(() => {
		sendMessage.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('probes the endpoint origin with a GET through the fetchProxy', async () => {
		sendMessage.mockResolvedValue({ ok: true, status: 200, text: 'ok' });

		await expect(checkEndpointHealth(localProxy)).resolves.toBe('alive');

		expect(sendMessage).toHaveBeenCalledTimes(1);
		const message = sendMessage.mock.calls[0][0] as any;
		expect(message.action).toBe('fetchProxy');
		expect(message.url).toBe('http://127.0.0.1:1455');
		expect(message.options.method).toBe('GET');
	});

	test('any HTTP response counts as alive, even a 404', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 404, text: 'not found' });

		await expect(checkEndpointHealth(localProxy)).resolves.toBe('alive');
	});

	test('a proxy transport error is unreachable', async () => {
		sendMessage.mockResolvedValue({ ok: false, status: 0, text: '', error: 'CORS_PERMISSION_NEEDED' });

		await expect(checkEndpointHealth(localProxy)).resolves.toBe('unreachable');
	});

	test('a rejected proxy message is unreachable', async () => {
		sendMessage.mockRejectedValue(new Error('No runtime'));

		await expect(checkEndpointHealth(localProxy)).resolves.toBe('unreachable');
	});

	test('no settlement within timeoutMs is a timeout', async () => {
		vi.useFakeTimers();
		sendMessage.mockImplementation(() => new Promise(() => {}));

		const pending = checkEndpointHealth(localProxy, 3000);
		await vi.advanceTimersByTimeAsync(3000);

		await expect(pending).resolves.toBe('timeout');
	});

	test('a probe that settles just before the deadline is not a timeout', async () => {
		vi.useFakeTimers();
		sendMessage.mockImplementation(() => new Promise(resolve => {
			setTimeout(() => resolve({ ok: true, status: 200, text: 'ok' }), 2999);
		}));

		const pending = checkEndpointHealth(localProxy, 3000);
		await vi.advanceTimersByTimeAsync(3000);

		await expect(pending).resolves.toBe('alive');
	});
});
