// @vitest-environment jsdom
// Golden-master regression for LLM request construction (fork issue #2).
// Captures the exact { url, headers, body } sent for every provider shape so
// the fetchProxy refactor can prove request parity field by field.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendToLLM } from './interpreter';
import { generalSettings } from './storage-utils';
import { ModelConfig, PromptVariable, Provider } from '../types/types';

const PROMPT_CONTEXT = 'You are provided with the article "Example title" from example.com.';
const PROMPT_VARIABLES: PromptVariable[] = [
	{ key: 'prompt_1', prompt: 'Summarize the page' },
	{ key: 'prompt_2', prompt: 'Suggest three tags' }
];
const LLM_JSON_REPLY = '{"prompts_responses":{"prompt_1":"A summary","prompt_2":"tag1, tag2, tag3"}}';

interface ProviderCase {
	label: string;
	provider: Provider;
	providerModelId: string;
	// Response envelope the provider would return, wrapping LLM_JSON_REPLY
	response: unknown;
}

const CASES: ProviderCase[] = [
	{
		label: 'anthropic',
		provider: {
			id: 'anthropic',
			name: 'Anthropic',
			baseUrl: 'https://api.anthropic.com/v1/messages',
			apiKey: 'test-anthropic-key'
		},
		providerModelId: 'claude-sonnet-5',
		response: { content: [{ type: 'text', text: LLM_JSON_REPLY }], stop_reason: 'end_turn' }
	},
	{
		label: 'openai-default',
		provider: {
			id: 'openai',
			name: 'OpenAI',
			baseUrl: 'https://api.openai.com/v1/chat/completions',
			apiKey: 'test-openai-key'
		},
		providerModelId: 'gpt-5.6-sol',
		response: { choices: [{ message: { content: LLM_JSON_REPLY }, finish_reason: 'stop' }] }
	},
	{
		label: 'azure-openai',
		provider: {
			id: 'azure',
			name: 'Azure OpenAI',
			baseUrl: 'https://myresource.openai.azure.com/openai/deployments/{deployment-id}/chat/completions?api-version=2024-10-21',
			apiKey: 'test-azure-key'
		},
		providerModelId: 'my-deployment',
		response: { choices: [{ message: { content: LLM_JSON_REPLY }, finish_reason: 'stop' }] }
	},
	{
		label: 'deepseek',
		provider: {
			id: 'deepseek',
			name: 'DeepSeek',
			baseUrl: 'https://api.deepseek.com/chat/completions',
			apiKey: 'test-deepseek-key'
		},
		providerModelId: 'deepseek-v4-pro',
		response: { choices: [{ message: { content: LLM_JSON_REPLY }, finish_reason: 'stop' }] }
	},
	{
		label: 'gemini',
		provider: {
			id: 'gemini',
			name: 'Google Gemini',
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model-id}:generateContent',
			apiKey: 'test-gemini-key'
		},
		providerModelId: 'gemini-2.5-flash',
		response: { candidates: [{ content: { parts: [{ text: LLM_JSON_REPLY }] }, finishReason: 'STOP' }] }
	},
	{
		label: 'huggingface',
		provider: {
			id: 'huggingface',
			name: 'Hugging Face',
			baseUrl: 'https://api-inference.huggingface.co/models/{model-id}/v1/chat/completions',
			apiKey: 'test-hf-key'
		},
		providerModelId: 'meta-llama/Llama-3.3-70B-Instruct',
		response: { choices: [{ message: { content: LLM_JSON_REPLY }, finish_reason: 'stop' }] }
	},
	{
		label: 'perplexity',
		provider: {
			id: 'perplexity',
			name: 'Perplexity',
			baseUrl: 'https://api.perplexity.ai/chat/completions',
			apiKey: 'test-perplexity-key'
		},
		providerModelId: 'sonar-pro',
		response: { choices: [{ message: { content: LLM_JSON_REPLY }, finish_reason: 'stop' }] }
	},
	{
		label: 'ollama',
		provider: {
			id: 'ollama',
			name: 'Ollama',
			baseUrl: 'http://127.0.0.1:11434/api/chat',
			apiKey: '',
			apiKeyRequired: false
		},
		providerModelId: 'llama3.3',
		response: { message: { content: LLM_JSON_REPLY }, done_reason: 'stop' }
	}
];

function modelFor(c: ProviderCase): ModelConfig {
	return {
		id: `model-${c.label}`,
		providerId: c.provider.id,
		providerModelId: c.providerModelId,
		name: `Model ${c.label}`,
		enabled: true
	};
}

describe('LLM request construction (golden master)', () => {
	let captured: { url: string; headers: Record<string, string>; body: unknown } | undefined;
	// Monotonic clock across tests — the module-level rate limiter in
	// interpreter.ts persists between tests, so time must only move forward
	let clock = new Date('2030-01-01T00:00:00Z').getTime();

	beforeEach(() => {
		vi.useFakeTimers();
		clock += 120_000;
		vi.setSystemTime(clock);
		captured = undefined;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function stubNetwork(response: unknown) {
		vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
			captured = {
				url,
				headers: { ...(init.headers as Record<string, string>) },
				body: JSON.parse(init.body as string)
			};
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				text: async () => JSON.stringify(response)
			};
		}));
	}

	for (const c of CASES) {
		test(`${c.label}: request url, headers and body`, async () => {
			generalSettings.providers = [c.provider];
			stubNetwork(c.response);

			const { promptResponses } = await sendToLLM(
				PROMPT_CONTEXT,
				'<article>content</article>',
				PROMPT_VARIABLES,
				modelFor(c)
			);

			expect(captured).toMatchSnapshot();
			// The parsed responses prove the provider-specific envelope was unwrapped
			expect(promptResponses).toHaveLength(2);
			expect(promptResponses[0].user_response).toBeDefined();
		});
	}

	test('rejects when the provider is missing an API key it requires', async () => {
		const provider: Provider = {
			id: 'openai',
			name: 'OpenAI',
			baseUrl: 'https://api.openai.com/v1/chat/completions',
			apiKey: '',
			apiKeyRequired: true
		};
		generalSettings.providers = [provider];
		stubNetwork({});

		await expect(sendToLLM(PROMPT_CONTEXT, '', PROMPT_VARIABLES, {
			id: 'm', providerId: 'openai', providerModelId: 'gpt-5.6-sol', name: 'GPT', enabled: true
		})).rejects.toThrow('API key is not set');
	});
});
