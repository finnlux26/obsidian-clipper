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

export function buildChatRequest(
	provider: Provider,
	model: ModelConfig,
	systemContent: string,
	context: string,
	payload: string
): ChatRequestSpec {
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
		// Default request format
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
			'Authorization': `Bearer ${provider.apiKey}`
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
	} catch {
		result = undefined;
	}

	if (!result || typeof result.ok !== 'boolean' || result.error === 'CORS_PERMISSION_NEEDED') {
		return fetch(spec.url, {
			method: 'POST',
			headers: spec.headers,
			body: JSON.stringify(spec.body)
		});
	}

	if (result.error) {
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

export async function sendChatRequest(
	provider: Provider,
	model: ModelConfig,
	parts: ChatMessageParts
): Promise<string> {
	const spec = buildChatRequest(provider, model, parts.system, parts.context, parts.payload);

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
