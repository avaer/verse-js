// lexer.ts
// Hand-written Verse lexer with significant-indentation handling.
//
// Emits a flat token stream in which block structure appears as
// indent/dedent/newline tokens (suppressed inside brackets), so the parser
// can treat the three Verse block forms (indented, braced, semicolon
// one-liners) uniformly. String literals carry their `{...}` interpolation
// segments as raw sub-source parts which the parser parses recursively.

import { OPERATORS, SourcePos, StringPart, Token } from './tokens';

export class VerseSyntaxError extends Error {
	pos: SourcePos;
	endPos: SourcePos | null;

	constructor(message: string, pos: SourcePos, endPos: SourcePos | null = null) {
		super(message);
		this.name = 'VerseSyntaxError';
		this.pos = pos;
		this.endPos = endPos;
	}
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function lex(source: string): Token[] {
	return new Lexer(source).run();
}

class Lexer {
	private src: string;
	private pos = 0;
	private line = 1;
	private col = 1;
	private tokens: Token[] = [];
	private indentStack: number[] = [0];
	private bracketDepth = 0;
	private atLineStart = true;
	private spacePending = false;

	constructor(source: string) {
		// Normalize line endings once so position math is simple.
		this.src = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}

	run(): Token[] {
		while (this.pos < this.src.length) {
			if (this.atLineStart && this.bracketDepth === 0) {
				this.handleLineStart();
				if (this.pos >= this.src.length) {
					break;
				}
			}

			const ch = this.src[this.pos];

			if (ch === '\n') {
				this.consumeNewline();
				continue;
			}
			if (ch === ' ' || ch === '\t') {
				this.advance();
				this.spacePending = true;
				continue;
			}
			if (ch === '#') {
				this.skipLineComment();
				continue;
			}
			if (ch === '<' && this.src[this.pos + 1] === '#') {
				this.skipBlockComment();
				continue;
			}
			if (ch === '"') {
				this.lexString();
				continue;
			}
			if (ch === "'") {
				this.lexChar();
				continue;
			}
			if (DIGIT.test(ch)) {
				this.lexNumber();
				continue;
			}
			if (IDENT_START.test(ch)) {
				this.lexIdent();
				continue;
			}
			this.lexOperator();
		}

		// Close the final logical line and any open blocks.
		this.emitNewlineToken();
		while (this.indentStack.length > 1) {
			this.indentStack.pop();
			this.push('dedent', '');
		}
		this.push('eof', '');
		return this.tokens;
	}

	// --- line / indentation handling ---

	private handleLineStart(): void {
		// Measure indentation of the next non-blank, non-comment-only line.
		for (;;) {
			let indent = 0;
			let scan = this.pos;
			while (scan < this.src.length) {
				const ch = this.src[scan];
				if (ch === ' ') {
					indent += 1;
				} else if (ch === '\t') {
					indent += 4;
				} else {
					break;
				}
				scan += 1;
			}
			if (scan >= this.src.length) {
				this.moveTo(scan);
				return;
			}
			const ch = this.src[scan];
			if (ch === '\n') {
				this.moveTo(scan + 1, true);
				continue;
			}
			if (ch === '#') {
				let end = scan;
				while (end < this.src.length && this.src[end] !== '\n') {
					end += 1;
				}
				this.moveTo(Math.min(end + 1, this.src.length), true);
				continue;
			}

			this.moveTo(scan);
			this.applyIndent(indent);
			this.atLineStart = false;
			return;
		}
	}

	private applyIndent(indent: number): void {
		const current = this.indentStack[this.indentStack.length - 1];
		if (indent > current) {
			this.indentStack.push(indent);
			this.push('indent', '');
			return;
		}
		while (indent < this.indentStack[this.indentStack.length - 1]) {
			this.indentStack.pop();
			this.push('dedent', '');
		}
		// Lenient about slightly-mismatched dedents (Epic's parser recovers
		// too); the parser reports structural problems with better context.
	}

	private consumeNewline(): void {
		this.advance();
		if (this.bracketDepth === 0) {
			this.emitNewlineToken();
			this.atLineStart = true;
		}
		this.spacePending = false;
	}

	private emitNewlineToken(): void {
		const last = this.tokens[this.tokens.length - 1];
		if (!last || last.kind === 'newline' || last.kind === 'indent' || last.kind === 'dedent') {
			return;
		}
		this.push('newline', '');
	}

	// --- comments ---

	private skipLineComment(): void {
		while (this.pos < this.src.length && this.src[this.pos] !== '\n') {
			this.advance();
		}
		this.spacePending = true;
	}

	private skipBlockComment(): void {
		const start = this.here();
		this.advance(); // <
		this.advance(); // #
		let depth = 1;
		while (this.pos < this.src.length && depth > 0) {
			if (this.src[this.pos] === '<' && this.src[this.pos + 1] === '#') {
				depth += 1;
				this.advance();
				this.advance();
			} else if (this.src[this.pos] === '#' && this.src[this.pos + 1] === '>') {
				depth -= 1;
				this.advance();
				this.advance();
			} else {
				this.advance();
			}
		}
		if (depth > 0) {
			throw new VerseSyntaxError('Unterminated block comment (missing "#>")', start);
		}
		this.spacePending = true;
	}

	// --- literals ---

	private lexString(): void {
		const start = this.here();
		this.advance(); // opening quote
		const parts: StringPart[] = [];
		let text = '';
		let textPos = this.here();

		const flushText = () => {
			if (text.length > 0) {
				parts.push({ type: 'text', text, pos: textPos });
				text = '';
			}
		};

		for (;;) {
			if (this.pos >= this.src.length || this.src[this.pos] === '\n') {
				throw new VerseSyntaxError('Unterminated string literal', start, this.here());
			}
			const ch = this.src[this.pos];
			if (ch === '"') {
				this.advance();
				break;
			}
			if (ch === '\\') {
				text += this.readEscape();
				continue;
			}
			if (ch === '{') {
				flushText();
				const interpStart = this.here();
				this.advance(); // {
				const exprStart = this.pos;
				let depth = 1;
				while (this.pos < this.src.length && depth > 0) {
					const c = this.src[this.pos];
					if (c === '{') {
						depth += 1;
					} else if (c === '}') {
						depth -= 1;
						if (depth === 0) {
							break;
						}
					} else if (c === '"' || c === '\n') {
						// Keep interpolations single-line and quote-free; this
						// matches how Verse code uses them in practice.
						break;
					}
					this.advance();
				}
				if (this.pos >= this.src.length || this.src[this.pos] !== '}') {
					throw new VerseSyntaxError('Unterminated string interpolation (missing "}")', interpStart, this.here());
				}
				const exprSource = this.src.slice(exprStart, this.pos);
				this.advance(); // }
				parts.push({
					type: 'interp',
					text: exprSource,
					pos: { line: interpStart.line, col: interpStart.col + 1, offset: interpStart.offset + 1 },
				});
				textPos = this.here();
				continue;
			}
			text += ch;
			this.advance();
		}
		flushText();

		const raw = this.src.slice(start.offset, this.pos);
		this.push('string', raw, { parts });
	}

	private readEscape(): string {
		const escStart = this.here();
		this.advance(); // backslash
		if (this.pos >= this.src.length) {
			throw new VerseSyntaxError('Unterminated escape sequence', escStart);
		}
		const ch = this.src[this.pos];
		this.advance();
		switch (ch) {
			case 'n': return '\n';
			case 't': return '\t';
			case 'r': return '\r';
			case '0': return '\0';
			case '\\': return '\\';
			case '"': return '"';
			case "'": return "'";
			case '{': return '{';
			case '}': return '}';
			default:
				throw new VerseSyntaxError(`Unknown escape sequence '\\${ch}'`, escStart);
		}
	}

	private lexChar(): void {
		const start = this.here();
		this.advance(); // opening quote
		if (this.pos >= this.src.length || this.src[this.pos] === '\n') {
			throw new VerseSyntaxError('Unterminated character literal', start);
		}
		let value: string;
		if (this.src[this.pos] === '\\') {
			value = this.readEscape();
		} else {
			// Consume one full Unicode code point (handles astral chars).
			const cp = this.src.codePointAt(this.pos);
			value = String.fromCodePoint(cp ?? 0);
			for (let i = 0; i < value.length; i++) {
				this.advance();
			}
		}
		if (this.pos >= this.src.length || this.src[this.pos] !== "'") {
			throw new VerseSyntaxError("Unterminated character literal (missing closing ')", start, this.here());
		}
		this.advance();
		const raw = this.src.slice(start.offset, this.pos);
		this.push('char', raw, { value });
	}

	private lexNumber(): void {
		const start = this.here();

		if (this.src[this.pos] === '0' && (this.src[this.pos + 1] === 'x' || this.src[this.pos + 1] === 'X')) {
			this.advance();
			this.advance();
			let digits = '';
			while (this.pos < this.src.length && /[0-9a-fA-F_]/.test(this.src[this.pos])) {
				if (this.src[this.pos] !== '_') {
					digits += this.src[this.pos];
				}
				this.advance();
			}
			if (digits.length === 0) {
				throw new VerseSyntaxError('Invalid hexadecimal literal', start, this.here());
			}
			this.push('int', this.src.slice(start.offset, this.pos), { value: parseInt(digits, 16) });
			return;
		}
		if (this.src[this.pos] === '0' && (this.src[this.pos + 1] === 'b' || this.src[this.pos + 1] === 'B')) {
			this.advance();
			this.advance();
			let digits = '';
			while (this.pos < this.src.length && /[01_]/.test(this.src[this.pos])) {
				if (this.src[this.pos] !== '_') {
					digits += this.src[this.pos];
				}
				this.advance();
			}
			if (digits.length === 0) {
				throw new VerseSyntaxError('Invalid binary literal', start, this.here());
			}
			this.push('int', this.src.slice(start.offset, this.pos), { value: parseInt(digits, 2) });
			return;
		}

		let digits = '';
		let isFloat = false;
		while (this.pos < this.src.length && /[0-9_]/.test(this.src[this.pos])) {
			if (this.src[this.pos] !== '_') {
				digits += this.src[this.pos];
			}
			this.advance();
		}
		// A '.' begins a fraction only when followed by a digit; `0..10` must
		// stay `0`, `..`, `10`.
		if (
			this.src[this.pos] === '.' &&
			this.pos + 1 < this.src.length &&
			DIGIT.test(this.src[this.pos + 1])
		) {
			isFloat = true;
			digits += '.';
			this.advance();
			while (this.pos < this.src.length && /[0-9_]/.test(this.src[this.pos])) {
				if (this.src[this.pos] !== '_') {
					digits += this.src[this.pos];
				}
				this.advance();
			}
		}
		if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
			const save = this.pos;
			let exp = this.src[this.pos];
			this.advance();
			if (this.src[this.pos] === '+' || this.src[this.pos] === '-') {
				exp += this.src[this.pos];
				this.advance();
			}
			if (this.pos < this.src.length && DIGIT.test(this.src[this.pos])) {
				isFloat = true;
				while (this.pos < this.src.length && /[0-9_]/.test(this.src[this.pos])) {
					if (this.src[this.pos] !== '_') {
						exp += this.src[this.pos];
					}
					this.advance();
				}
				digits += exp;
			} else {
				// Not an exponent (e.g. `1else`); rewind.
				this.rewindTo(save);
			}
		}

		const raw = this.src.slice(start.offset, this.pos);
		if (isFloat) {
			this.push('float', raw, { value: parseFloat(digits) });
		} else {
			this.push('int', raw, { value: parseInt(digits, 10) });
		}
	}

	private lexIdent(): void {
		const start = this.here();
		while (this.pos < this.src.length && IDENT_PART.test(this.src[this.pos])) {
			this.advance();
		}
		const text = this.src.slice(start.offset, this.pos);
		this.push('ident', text);
	}

	private lexOperator(): void {
		const start = this.here();
		for (const op of OPERATORS) {
			if (this.src.startsWith(op, this.pos)) {
				for (let i = 0; i < op.length; i++) {
					this.advance();
				}
				if (op === '(' || op === '[' || op === '{') {
					this.bracketDepth += 1;
				} else if (op === ')' || op === ']' || op === '}') {
					this.bracketDepth = Math.max(0, this.bracketDepth - 1);
				}
				this.push('op', op);
				return;
			}
		}
		throw new VerseSyntaxError(`Unexpected character '${this.src[this.pos]}'`, start);
	}

	// --- low-level cursor helpers ---

	private here(): SourcePos {
		return { line: this.line, col: this.col, offset: this.pos };
	}

	private advance(): void {
		if (this.src[this.pos] === '\n') {
			this.line += 1;
			this.col = 1;
		} else {
			this.col += 1;
		}
		this.pos += 1;
	}

	private rewindTo(offset: number): void {
		// Only used within a single line, so column math is safe.
		this.col -= this.pos - offset;
		this.pos = offset;
	}

	private moveTo(offset: number, crossedNewline = false): void {
		while (this.pos < offset) {
			this.advance();
		}
		if (crossedNewline) {
			this.atLineStart = true;
		}
	}

	private push(kind: Token['kind'], text: string, extra: Partial<Token> = {}): void {
		const end = this.here();
		let start: SourcePos;
		if (kind === 'newline' || kind === 'indent' || kind === 'dedent' || kind === 'eof') {
			start = end;
		} else {
			start = {
				line: end.line,
				col: end.col - (end.offset - (end.offset - text.length >= 0 ? end.offset - text.length : 0)),
				offset: end.offset - text.length,
			};
			// Recompute the column robustly for tokens that never span lines.
			start.col = end.col - text.length;
			if (start.col < 1) {
				start.col = 1;
			}
		}
		this.tokens.push({
			kind,
			text,
			span: { start, end },
			spaceBefore: this.spacePending,
			...extra,
		});
		this.spacePending = false;
	}
}
