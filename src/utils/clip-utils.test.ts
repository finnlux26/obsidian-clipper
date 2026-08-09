// @vitest-environment jsdom
// Clipping must save the original article: inserted translation comparison
// nodes are filtered out of the parsed content (fork issue #6).
import { describe, test, expect } from 'vitest';
import { parseForClip } from './clip-utils';

describe('parseForClip', () => {
	test('reader mode: inserted translation nodes are excluded from the clip', () => {
		document.body.innerHTML = `
			<div class="obsidian-reader-active">
				<div class="obsidian-reader-content">
					<article>
						<h1>How Banks Work</h1>
						<p>The bank raised interest rates yesterday.</p>
						<p class="obsidian-reader-translation" data-src-hash="abc">银行昨天加息了。</p>
						<p>Markets reacted quickly to the announcement.</p>
					</article>
				</div>
			</div>`;

		const parsed = parseForClip(document);

		expect(parsed.content).toContain('interest rates');
		expect(parsed.content).toContain('Markets reacted');
		expect(parsed.content).not.toContain('银行昨天加息了');
		// The live DOM keeps its translation node — only the clip is filtered
		expect(document.querySelector('.obsidian-reader-translation')).not.toBeNull();
	});
});
