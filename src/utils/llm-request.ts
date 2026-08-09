import browser from './browser-polyfill';
import { ModelConfig, Provider } from '../types/types';
import { debugLog } from './debug';

// Generic LLM chat request layer, extracted from the interpreter so other
// features (e.g. translation) can reuse it without the template prompt
// variable flow. Request construction is pure; sending is routed through the
// background fetchProxy so extension pages never fetch LLM endpoints
// directly — required for localhost providers (Private Network Access) and
// Firefox host-permission handling. Environments without a background proxy
// (CLI, tests, permission-restricted contexts) fall back to a direct fetch,
// which matches the previous behavior.

export interface ChatRequestSpec {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export interface ChatMessageParts {
	system: string;
	context: string;
	payload: string;
}

// Thrown when the model hit its output token limit. Callers may want to
// treat this differently from transport errors (the request was consumed).
export class LLMTruncatedError extends Error {}

// Thrown when a local (localhost/loopback) endpoint could not be reached at
// the transport level — the local proxy or model server is not running.
// Callers show "start your local proxy" guidance instead of a generic
// failure (fork issue #8).
export class LocalEndpointUnreachableError extends Error {
	readonly origin: string;

	constructor(origin: string) {
		super(`Local endpoint ${origin} is not responding. Start your local proxy or model server and try again.`);
		this.name = 'LocalEndpointUnreachableError';
		this.origin = origin;
	}
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

// Whether a URL targets a local endpoint (Ollama, a Codex-subscription
// proxy, LM Studio, …). Only exact loopback hosts count — subdomains like
// localhost.example.com do not.
export function isLocalEndpoint(url: string): boolean {
	try {
		return LOCAL_HOSTNAMES.has(new URL(url).hostname.toLowerCase());
	} catch {
		return false;
	}
}

function endpointOrigin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

export function buildChatRequest(
	provider: Provider,
	model: ModelConfig,
	parts: ChatMessageParts
): ChatRequestSpec {
	const { system: systemContent, context, payload } = parts;
	let requestUrl: string;
	let requestBody: Record<string, unknown>;
	let headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Accept': 'application/json',
	};

	if (provider.name.toLowerCase().includes('hugging')) {
		// Replace {model-id} in baseUrl with the actual model ID
		requestUrl = provider.baseUrl.replace('{model-id}', model.providerModelId);
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			max_tokens: 1600,
			stream: false
		};
		headers = {
			...headers,
			'Authorization': `Bearer ${provider.apiKey}`
		};
	} else if (provider.baseUrl.includes('openai.azure.com')) {
		// Azure routes by deployment in the URL, not by a model field in the body
		requestUrl = provider.baseUrl.replace('{deployment-id}', model.providerModelId);
		requestBody = {
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			max_completion_tokens: 8000,
			stream: false
		};
		headers = {
			...headers,
			'api-key': provider.apiKey
		};
	} else if (provider.name.toLowerCase().includes('deepseek')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			max_tokens: 8000,
			thinking: {
				type: 'disabled'
			},
			stream: false
		};
		headers = {
			...headers,
			'Authorization': `Bearer ${provider.apiKey}`
		};
	} else if (provider.baseUrl.includes('generativelanguage.googleapis.com')) {
		// Use the native Gemini API — Google's OpenAI-compatible endpoint
		// rejects the newer AQ-prefixed API keys
		requestUrl = provider.baseUrl.includes('{model-id}')
			? provider.baseUrl.replace('{model-id}', model.providerModelId)
			: `https://generativelanguage.googleapis.com/v1beta/models/${model.providerModelId}:generateContent`;
		requestBody = {
			systemInstruction: { parts: [{ text: systemContent }] },
			contents: [
				{
					role: 'user',
					parts: [
						{ text: context },
						{ text: payload }
					]
				}
			],
			generationConfig: {
				maxOutputTokens: 8000,
				responseMimeType: 'application/json'
			}
		};
		headers = {
			...headers,
			'X-goog-api-key': provider.apiKey
		};
	} else if (provider.name.toLowerCase().includes('anthropic')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			max_tokens: 8000,
			messages: [
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			system: systemContent
		};
		headers = {
			...headers,
			'x-api-key': provider.apiKey,
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true'
		};
	} else if (provider.name.toLowerCase().includes('perplexity')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			max_tokens: 8000,
			messages: [
				{ role: 'system', content: systemContent },
				// Whitespace inside the template literal is load-bearing:
				// it reproduces the exact message bytes sent before this
				// layer was extracted (see the golden-master snapshots)
				{ role: 'user', content: `\n\t\t\t\t\t\t"${context}"\n\t\t\t\t\t\t"${payload}"` }
			]
		};
		headers = {
			...headers,
			'HTTP-Referer': 'https://obsidian.md/',
			'X-Title': 'Obsidian Web Clipper',
			'Authorization': `Bearer ${provider.apiKey}`
		};
	} else if (provider.name.toLowerCase().includes('ollama')) {
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			format: 'json',
			num_ctx: 120000,
			stream: false
		};
	} else {
		// Default request format (OpenAI-compatible, including local proxies)
		requestUrl = provider.baseUrl;
		requestBody = {
			model: model.providerModelId,
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: context },
				{ role: 'user', content: payload }
			],
			stream: false
		};
		headers = {
			...headers,
			'HTTP-Referer': 'https://obsidian.md/',
			'X-Title': 'Obsidian Web Clipper',
			// Keyless providers (local proxies) must not send a malformed
			// "Bearer " header — strict servers reject it
			...(provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {})
		};
	}

	return { url: requestUrl, headers, body: requestBody };
}

interface ProxyResult {
	ok: boolean;
	status: number;
	text: string;
	error?: string;
}

interface FetchLike {
	ok: boolean;
	status: number;
	statusText: string;
	text(): Promise<string>;
}

// Send via the background fetchProxy; fall back to a direct fetch when the
// proxy is unavailable (CLI/tests) or reports a missing host permission
// (Firefox), which preserves the pre-refactor direct-fetch behavior.
async function proxiedFetch(spec: ChatRequestSpec): Promise<FetchLike> {
	const local = isLocalEndpoint(spec.url);
	let result: ProxyResult | undefined;
	try {
		result = await browser.runtime.sendMessage({
			action: 'fetchProxy',
			url: spec.url,
			options: {
				method: 'POST',
				headers: spec.headers,
				body: JSON.stringify(spec.body)
			}
		}) as ProxyResult | undefined;
	} catch (error) {
		debugLog('LLM', 'fetchProxy unavailable, falling back to direct fetch:', error);
		result = undefined;
	}

	// CORS_PERMISSION_NEEDED falls back to a direct page fetch rather than
	// prompting via permissions.request() like reader-view does: this call may
	// run outside a user gesture, and the direct attempt preserves the exact
	// pre-refactor behavior on Firefox without a host grant
	if (!result || typeof result.ok !== 'boolean' || result.error === 'CORS_PERMISSION_NEEDED') {
		try {
			return await fetch(spec.url, {
				method: 'POST',
				headers: spec.headers,
				body: JSON.stringify(spec.body)
			});
		} catch (error) {
			// A rejected fetch against a loopback host means nothing is
			// listening — surface actionable guidance instead of a raw
			// TypeError (fork issue #8)
			if (local) {
				throw new LocalEndpointUnreachableError(endpointOrigin(spec.url));
			}
			throw error;
		}
	}

	if (result.error || (local && result.status === 0)) {
		if (local) {
			throw new LocalEndpointUnreachableError(endpointOrigin(spec.url));
		}
		throw new Error(result.error);
	}

	const { ok, status, text } = result;
	return {
		ok,
		status,
		statusText: '',
		text: async () => text
	};
}

export type EndpointHealth = 'alive' | 'unreachable' | 'timeout';

// Probe a provider's endpoint origin with a plain GET through the background
// fetchProxy. Any HTTP response — even a 404 from a server that only speaks
// POST /v1/chat/completions — proves something is listening ('alive'). A
// transport-level failure is 'unreachable'; no settlement within timeoutMs
// is 'timeout'. Callers use this to pre-flight local proxies (fork issue #8).
export async function checkEndpointHealth(provider: Provider, timeoutMs = 3000): Promise<EndpointHealth> {
	let origin: string;
	try {
		origin = new URL(provider.baseUrl).origin;
	} catch {
		return 'unreachable';
	}

	const probe: Promise<EndpointHealth> = (async () => {
		try {
			const result = await browser.runtime.sendMessage({
				action: 'fetchProxy',
				url: origin,
				options: { method: 'GET' }
			}) as ProxyResult | undefined;
			if (!result || typeof result.status !== 'number' || result.error || result.status === 0) {
				return 'unreachable';
			}
			return 'alive';
		} catch (error) {
			debugLog('LLM', 'Endpoint health probe failed:', error);
			return 'unreachable';
		}
	})();

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<EndpointHealth>(resolve => {
		timer = setTimeout(() => resolve('timeout'), timeoutMs);
	});
	try {
		return await Promise.race([probe, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function sendChatRequest(
	provider: Provider,
	model: ModelConfig,
	parts: ChatMessageParts
): Promise<string> {
	const spec = buildChatRequest(provider, model, parts);

	debugLog('LLM', `Sending request to ${provider.name} API:`, spec.body);

	const response = await proxiedFetch(spec);

	if (!response.ok) {
		const errorText = await response.text();
		console.error(`${provider.name} error response:`, errorText);

		// Add specific message for Ollama 403 errors
		if (provider.name.toLowerCase().includes('ollama') && response.status === 403) {
			throw new Error(
				`Ollama cannot process requests originating from a browser extension without setting OLLAMA_ORIGINS. ` +
				`See instructions at https://help.obsidian.md/web-clipper/interpreter`
			);
		}

		const statusLabel = response.statusText || `HTTP ${response.status}`;
		throw new Error(`${provider.name} error: ${statusLabel} ${errorText}`);
	}

	const responseText = await response.text();
	debugLog('LLM', `Raw ${provider.name} response:`, responseText);

	let data;
	try {
		data = JSON.parse(responseText);
	} catch (error) {
		console.error('Error parsing JSON response:', error);
		throw new Error(`Failed to parse response from ${provider.name}`);
	}

	debugLog('LLM', `Parsed ${provider.name} response:`, data);

	// Surface truncated responses instead of silently saving incomplete output
	const finishReason = data.stop_reason // Anthropic
		?? data.done_reason // Ollama
		?? data.candidates?.[0]?.finishReason // Gemini
		?? data.choices?.[0]?.finish_reason; // OpenAI-compatible providers
	if (finishReason === 'max_tokens' || finishReason === 'length' || finishReason === 'MAX_TOKENS') {
		throw new LLMTruncatedError(`${provider.name} response was cut off because it reached the output token limit. Try shorter prompts or a smaller prompt context.`);
	}

	return extractResponseContent(provider, data);
}

function extractResponseContent(provider: Provider, data: any): string {
	if (provider.name.toLowerCase().includes('anthropic')) {
		// Find the text block — newer models may return a thinking block first
		const textContent = data.content?.find((block: any) => block.type === 'text')?.text;
		if (textContent) {
			try {
				// Try to parse the inner content first
				const parsed = JSON.parse(textContent);
				return JSON.stringify(parsed);
			} catch {
				// If parsing fails, use the raw text
				return textContent;
			}
		}
		return JSON.stringify(data);
	}

	if (provider.baseUrl.includes('generativelanguage.googleapis.com')) {
		// Native Gemini responses carry text in candidate content parts
		const parts = data.candidates?.[0]?.content?.parts;
		const textContent = Array.isArray(parts) ? parts.map((part: any) => part.text || '').join('') : undefined;
		if (textContent) {
			try {
				const parsed = JSON.parse(textContent);
				return JSON.stringify(parsed);
			} catch {
				return textContent;
			}
		}
		return JSON.stringify(data);
	}

	if (provider.name.toLowerCase().includes('ollama')) {
		const messageContent = data.message?.content;
		if (messageContent) {
			try {
				const parsed = JSON.parse(messageContent);
				return JSON.stringify(parsed);
			} catch {
				return messageContent;
			}
		}
		return JSON.stringify(data);
	}

	return data.choices?.[0]?.message?.content || JSON.stringify(data);
}
