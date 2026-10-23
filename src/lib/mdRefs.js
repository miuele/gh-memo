// The files a Markdown note refers to, found without the Markdown engine
// (which loads lazily), for plugins/markdown's references().
//
// images(content) lists image sources as written: ![alt](src),
// reference-style images (![alt][label], ![label][], ![label] with a
// [label]: src definition) and HTML <img src>. Fenced code blocks and code
// spans are skipped. When in doubt it lists a source rather than missing
// one: an extra entry only allows a read, while a missing one shows the
// image as missing. tests/e2e/smoke.cjs checks it against marked.
define('lib/mdRefs', [], () => {
	const BRACKETED = String.raw`(?:\\.|[^\\\[\]]|\[(?:\\.|[^\\\[\]])*\])*`;
	const TITLE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^()\\])*\))`;
	const DEST = String.raw`(?:<((?:\\.|[^\\<>\n])*)>|((?:\\.|[^\\\s()]|\((?:\\.|[^\\\s()])*\))*))`;

	const INLINE_IMAGE = new RegExp(String.raw`!\[${BRACKETED}\]\(\s*${DEST}(?:\s+${TITLE})?\s*\)`, 'g');
	const REF_IMAGE = new RegExp(String.raw`!\[(${BRACKETED})\](?:\[((?:\\.|[^\\\[\]])*)\])?`, 'g');
	const DEFINITION = new RegExp(String.raw`^ {0,3}\[((?:\\.|[^\\\[\]])+)\]:[ \t]*\n?[ \t]*(?:<((?:\\.|[^\\<>\n])*)>|(\S+))`, 'gm');
	const HTML_IMG = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
	const FENCE = /^ {0,3}(`{3,}|~{3,})/;
	// A code span: matching backtick runs, not across a blank line.
	const CODE_SPAN = /(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g;

	const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
	const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
	const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]);
	const label = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
	const blank = (s) => s.replace(/[^\n]/g, ' ');

	// The text outside fenced code blocks (an unclosed fence runs to the end).
	const withoutFences = (content) => {
		const out = [];
		let fence = null;
		for (const line of content.split('\n')) {
			const m = line.match(FENCE);
			if (fence) {
				if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) fence = null;
				out.push('');
			} else if (m && !(m[1][0] === '`' && line.slice(m[0].length).includes('`'))) {
				fence = m[1];
				out.push('');
			} else out.push(line);
		}
		return out.join('\n');
	};

	const images = (content) => {
		let text = withoutFences(String(content || '')).replace(CODE_SPAN, blank);
		const found = [];

		const defs = new Map();
		for (const m of text.matchAll(DEFINITION)) {
			const key = label(m[1]);
			if (!defs.has(key)) defs.set(key, unescape(m[2] ?? m[3]));
		}

		text = text.replace(INLINE_IMAGE, (whole, angled, bare) => {
			found.push(unescape(angled ?? bare ?? ''));
			return blank(whole);
		});
		for (const m of text.matchAll(REF_IMAGE)) {
			const src = defs.get(label(m[2] ? m[2] : m[1]));
			if (src !== undefined) found.push(src);
		}
		for (const m of text.matchAll(HTML_IMG)) found.push(decodeEntities(m[1] ?? m[2] ?? m[3]));

		return [...new Set(found.filter(Boolean))];
	};

	return { images };
});
