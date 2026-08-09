// Local HTTP server for the E2E suite (fork issue #4). Serves three things
// from a single ephemeral port so nothing in the tests ever leaves localhost:
//
//   GET  /pages/*              fixture pages from e2e/fixtures/pages
//   POST /v1/chat/completions  OpenAI-compatible mock LLM endpoint
//   GET  /__requests           JSON log of received LLM requests
//   POST /__reset              clears the request log
//
// Failure and latency are injected through the URL the extension is
// configured with (the provider baseUrl is used verbatim as the request URL,
// so query parameters travel through): `?fail=500` returns that HTTP status,
// `?delayMs=250` delays the response.
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

export interface LoggedRequest {
	method: string;
	url: string;
	body: string;
}

export interface MockServer {
	baseUrl: string;
	port: number;
	requests(): Promise<LoggedRequest[]>;
	reset(): Promise<void>;
	close(): Promise<void>;
}

// The canned translation the mock LLM returns. Exported so the spec asserts
// the exact strings that must surface in the popover.
export const CANNED_TRANSLATION = {
	translation: 'Flussufer',
	partOfSpeech: 'noun',
	meaningInContext: 'The strip of land alongside the river where she sat.',
	otherCommonMeanings: ['Bank (Geldinstitut)', 'Böschung']
};

const PAGES_DIR = path.join(__dirname, 'fixtures', 'pages');

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(body)
	});
	res.end(body);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function servePage(res: http.ServerResponse, pathname: string): Promise<void> {
	// Resolve inside the fixtures dir only; reject traversal attempts
	const relative = pathname.replace(/^\/pages\//, '');
	const filePath = path.join(PAGES_DIR, relative);
	if (!filePath.startsWith(PAGES_DIR + path.sep)) {
		res.writeHead(403);
		res.end('Forbidden');
		return;
	}
	try {
		const content = await fs.readFile(filePath);
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(content);
	} catch {
		res.writeHead(404);
		res.end('Not found');
	}
}

async function handleChatCompletion(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	url: URL,
	log: LoggedRequest[]
): Promise<void> {
	const body = await readBody(req);
	log.push({ method: req.method || '', url: url.pathname + url.search, body });

	const delayMs = Number(url.searchParams.get('delayMs') || '0');
	if (delayMs > 0) {
		await sleep(delayMs);
	}

	const fail = url.searchParams.get('fail');
	if (fail) {
		sendJson(res, Number(fail), { error: { message: 'Injected failure for E2E test' } });
		return;
	}

	sendJson(res, 200, {
		id: 'chatcmpl-e2e-mock',
		object: 'chat.completion',
		model: 'mock-model',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content: JSON.stringify(CANNED_TRANSLATION) },
				finish_reason: 'stop'
			}
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
	});
}

export async function startMockServer(): Promise<MockServer> {
	const log: LoggedRequest[] = [];

	const server = http.createServer((req, res) => {
		const url = new URL(req.url || '/', 'http://127.0.0.1');

		const route = async (): Promise<void> => {
			if (url.pathname.startsWith('/pages/')) {
				await servePage(res, url.pathname);
			} else if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
				await handleChatCompletion(req, res, url, log);
			} else if (url.pathname === '/__requests') {
				sendJson(res, 200, log);
			} else if (url.pathname === '/__reset' && req.method === 'POST') {
				log.length = 0;
				sendJson(res, 200, { ok: true });
			} else if (url.pathname === '/favicon.ico') {
				res.writeHead(204);
				res.end();
			} else {
				res.writeHead(404);
				res.end('Not found');
			}
		};

		route().catch(error => {
			// Surface handler failures to the client instead of hanging the request
			console.error('Mock server error:', error);
			if (!res.headersSent) {
				res.writeHead(500);
			}
			res.end('Mock server error');
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = (server.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;

	return {
		baseUrl,
		port,
		requests: async () => {
			const response = await fetch(`${baseUrl}/__requests`);
			return response.json() as Promise<LoggedRequest[]>;
		},
		reset: async () => {
			await fetch(`${baseUrl}/__reset`, { method: 'POST' });
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close(error => (error ? reject(error) : resolve()));
			})
	};
}
