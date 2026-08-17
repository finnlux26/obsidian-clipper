// @vitest-environment jsdom
// SSE streaming for LLM requests (fork issue #10). Streaming rides a
// long-lived runtime port to the background (message-passing can't stream);
// providers that aren't OpenAI-compatible fall back to the non-streaming
// path transparently.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import browser from './browser-polyfill';
import { createSseDeltaParser, sendChatRequestStream, supportsStreaming } from './llm-request';
import { ModelConfig, Provider } from '../types/types';

const openai: Provider = {
	id: 'openai',
	name: 'OpenAI',
	baseUrl: 'https://api.openai.com/v1/chat/completions',
	apiKey: 'key-o'
};
const localProxy: Provider = {
	id: 'local',
	name: 'Local proxy',
	baseUrl: 'http://127.0.0.1:1455/v1/chat/completions',
	apiKey: '',
	apiKeyRequired: false
};
const anthropic: Provider = {
	id: 'anthropic',
	name: 'Anthropic',
	baseUrl: 'https://api.anthropic.com/v1/messages',
	apiKey: 'key-a'
};

function model(provider: Provider): ModelConfig {
	return { id: 'm', providerId: provider.id, providerModelId: 'x', name: 'M', enabled: true };
}

const PARTS = { system: 'Translate.', context: 'ctx', payload: 'text' };

function sse(content: string): string {
	return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

describe('supportsStreaming', () => {
	test('OpenAI-compatible default-branch providers stream', () => {
		expect(supportsStreaming(openai)).toBe(true);
		expect(supportsStreaming(localProxy)).toBe(true);
	});

	test('provider-specific shapes do not stream', () => {
		expect(supportsStreaming(anthropic)).toBe(false);
	});
});

describe('createSseDeltaParser', () => {
	test('emits deltas in order and ignores [DONE]', () => {
		const parser = createSseDeltaParser();
		const deltas = parser.push(sse('你') + sse('好') + 'data: [DONE]\n');
		expect(deltas).toEqual(['你', '好']);
	});

	test('an event split across chunk boundaries stays buffered until complete', () => {
		const parser = createSseDeltaParser();
		const whole = sse('第一段译文');
		const first = parser.push(whole.slice(0, 25));
		const second = parser.push(whole.slice(25));
		expect(first).toEqual([]);
		expect(second).toEqual(['第一段译文']);
	});

	test('malformed events are skipped without derailing the stream', () => {
		const parser = createSseDeltaParser();
		const deltas = parser.push('data: {not json}\n' + sse('ok'));
		expect(deltas).toEqual(['ok']);
	});
});

describe('sendChatRequestStream', () => {
	const sendMessage = vi.spyOn(browser.runtime, 'sendMessage');

	function stubPort(script: Array<{ type: string; data?: string; message?: string; status?: number }>) {
		const listeners: Array<(msg: unknown) => void> = [];
		const port = {
			name: 'llm-stream',
			postMessage: vi.fn(() => {
				queueMicrotask(() => {
					for (const msg of script) listeners.forEach(l => l(msg));
				});
			}),
			disconnect: vi.fn(),
			onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
			onDisconnect: { addListener: vi.fn() }
		};
		(browser.runtime as any).connect = vi.fn(() => port);
		return port;
	}

	beforeEach(() => {
		sendMessage.mockReset();
	});

	afterEach(() => {
		delete (browser.runtime as any).connect;
	});

	test('streams deltas in order and resolves the concatenation', async () => {
		const port = stubPort([
			{ type: 'chunk', data: sse('银行') },
			{ type: 'chunk', data: sse('加息了。') },
			{ type: 'chunk', data: 'data: [DONE]\n' },
			{ type: 'done' }
		]);
		const deltas: string[] = [];

		const full = await sendChatRequestStream(openai, model(openai), PARTS, d => deltas.push(d));

		expect(deltas).toEqual(['银行', '加息了。']);
		expect(full).toBe('银行加息了。');
		const request = (port.postMessage as any).mock.calls[0][0];
		expect(JSON.parse(request.body).stream).toBe(true);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test('an endpoint that ignores stream=true and replies with plain JSON still resolves', async () => {
		stubPort([
			{ type: 'chunk', data: JSON.stringify({ choices: [{ message: { content: '整包译文' }, finish_reason: 'stop' }] }) },
			{ type: 'done' }
		]);
		const deltas: string[] = [];

		const full = await sendChatRequestStream(localProxy, model(localProxy), PARTS, d => deltas.push(d));

		expect(full).toBe('整包译文');
		expect(deltas).toEqual(['整包译文']);
	});

	test('non-streaming providers fall back to the proxy path with one delta', async () => {
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({ content: [{ type: 'text', text: '整段' }], stop_reason: 'end_turn' })
		});
		const deltas: string[] = [];

		const full = await sendChatRequestStream(anthropic, model(anthropic), PARTS, d => deltas.push(d));

		expect(full).toBe('整段');
		expect(deltas).toEqual(['整段']);
	});

	test('a stream error rejects with the provider name', async () => {
		stubPort([{ type: 'error', message: 'boom', status: 500 }]);

		await expect(
			sendChatRequestStream(openai, model(openai), PARTS, () => {})
		).rejects.toThrow(/OpenAI/);
	});

	test('a transport failure against a local endpoint surfaces the start-your-proxy error', async () => {
		stubPort([{ type: 'error', message: 'Failed to fetch', status: 0 }]);

		await expect(
			sendChatRequestStream(localProxy, model(localProxy), PARTS, () => {})
		).rejects.toThrow(/local proxy/i);
	});

	test('connect() being unavailable falls back to the non-streaming path', async () => {
		(browser.runtime as any).connect = vi.fn(() => { throw new Error('no ports'); });
		sendMessage.mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({ choices: [{ message: { content: 'fallback' }, finish_reason: 'stop' }] })
		});

		const full = await sendChatRequestStream(openai, model(openai), PARTS, () => {});

		expect(full).toBe('fallback');
	});
});
