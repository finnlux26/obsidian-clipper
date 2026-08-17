#!/usr/bin/env node
// Minimal OpenAI-compatible proxy backed by the local Codex CLI subscription.
// For manual verification of the translation feature (fork issue #8) — not a
// production server. Binds to loopback only.
//
//   node scripts/codex-proxy.mjs [port]     (default 1455)
//
// Requirements: `codex` CLI on PATH, logged in (`codex login status`).
// The extension's "Local proxy (OpenAI-compatible)" provider points at
// http://127.0.0.1:1455/v1/chat/completions and this answers it by running
// `codex exec` per request. Latency is agent-turn latency (seconds), and
// usage counts against the Codex subscription.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.argv[2]) || 1455;

function runCodex(prompt) {
	return new Promise((resolve, reject) => {
		const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-'));
		const outFile = join(dir, 'last-message.txt');
		const child = spawn('codex', [
			'exec',
			'--skip-git-repo-check',
			'-s', 'read-only',
			'--output-last-message', outFile,
			'-'
		], { stdio: ['pipe', 'ignore', 'pipe'] });

		let stderr = '';
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', err => {
			rmSync(dir, { recursive: true, force: true });
			reject(err);
		});
		child.on('close', code => {
			try {
				if (code !== 0) {
					reject(new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`));
					return;
				}
				resolve(readFileSync(outFile, 'utf8').trim());
			} catch (err) {
				reject(err);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
		child.stdin.end(prompt);
	});
}

function messagesToPrompt(messages) {
	// Flatten the chat into one prompt; codex exec is single-turn. The system
	// message leads so response-format instructions stay authoritative.
	return messages
		.map(m => (m.role === 'system' ? `Instructions:\n${m.content}` : m.content))
		.join('\n\n');
}

const server = createServer(async (req, res) => {
	if (req.method !== 'POST') {
		// Health checks: any HTTP response means "alive"
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, service: 'codex-proxy' }));
		return;
	}

	let raw = '';
	req.on('data', chunk => { raw += chunk; });
	req.on('end', async () => {
		try {
			const body = JSON.parse(raw);
			const prompt = messagesToPrompt(body.messages || []);
			console.log(`[codex-proxy] request: ${prompt.length} chars, model=${body.model || 'default'}`);
			const started = Date.now();
			const content = await runCodex(prompt);
			console.log(`[codex-proxy] answered in ${((Date.now() - started) / 1000).toFixed(1)}s: ${content.slice(0, 80)}…`);
			if (body.stream) {
				// codex exec is atomic, so the "stream" is one delta + DONE —
				// enough for the extension's SSE path to work end to end
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache'
				});
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
				res.write('data: [DONE]\n\n');
				res.end();
			} else {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					id: 'codex-proxy',
					object: 'chat.completion',
					model: body.model || 'codex',
					choices: [{
						index: 0,
						message: { role: 'assistant', content },
						finish_reason: 'stop'
					}]
				}));
			}
		} catch (err) {
			console.error('[codex-proxy] error:', err.message);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: String(err.message) } }));
		}
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`[codex-proxy] listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
	console.log('[codex-proxy] Ctrl-C to stop');
});
