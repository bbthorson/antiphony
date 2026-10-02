/**
 * Build-time code rendering for the hand-built examples on the homepage and
 * the lexicon pages. Tokenizing at build time keeps the pages script-free for
 * highlighting, and tagging each JSON line with its top-level field lets a
 * field table point at "its" line in the example beside it.
 */

export type TokenKind = 'key' | 'str' | 'num' | 'kw' | 'com' | 'plain';
export type Token = { text: string; kind: TokenKind };
export type CodeLine = { tokens: Token[]; field: string | null };

/**
 * JSON.stringify with short arrays and objects folded onto one line, so a
 * waveform or a blob ref reads as one value rather than ten lines of noise.
 */
export function pretty(value: unknown): string {
	let s = JSON.stringify(value, null, 2);
	for (let i = 0; i < 3; i++) {
		s = s.replace(/([[{])\n(\s+)([^[\]{}]*?)\n\s*([\]}])/g, (match, open, _indent, body: string, close) => {
			const one = body
				.split('\n')
				.map((x) => x.trim())
				.join(' ');
			return one.length < 58 ? `${open} ${one} ${close}` : match;
		});
	}
	return s;
}

const TOKEN_RE =
	/(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)(\s*:)?|\b(\d+)\b|\b(const|await|true|false|import|from|export|function|return)\b/g;

/** A deliberately small highlighter: comments, strings, keys, numbers, keywords. */
export function tokenize(line: string): Token[] {
	const out: Token[] = [];
	let last = 0;
	TOKEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN_RE.exec(line))) {
		if (m.index > last) out.push({ text: line.slice(last, m.index), kind: 'plain' });
		if (m[1]) out.push({ text: m[1], kind: 'com' });
		else if (m[2]) {
			out.push({ text: m[2], kind: m[3] ? 'key' : 'str' });
			if (m[3]) out.push({ text: m[3], kind: 'plain' });
		} else if (m[4]) out.push({ text: m[4], kind: 'num' });
		else if (m[5]) out.push({ text: m[5], kind: 'kw' });
		last = TOKEN_RE.lastIndex;
	}
	if (last < line.length) out.push({ text: line.slice(last), kind: 'plain' });
	return out;
}

/**
 * Split code into highlighted lines. Each line inside a top-level JSON field
 * (two-space indent, `"name":`) carries that field's name, including the
 * continuation lines of a multi-line value.
 */
export function codeLines(text: string): CodeLine[] {
	let field: string | null = null;
	return text.split('\n').map((line) => {
		const m = line.match(/^ {2}"([^"]+)":/);
		if (m) field = m[1];
		else if (/^[{}]/.test(line)) field = null;
		return { tokens: tokenize(line), field };
	});
}
