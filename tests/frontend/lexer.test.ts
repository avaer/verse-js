// Lexer conformance: block structure, literals, operators, comments.
import { describe, expect, it } from 'vitest';
import { lex } from '../../src/verse/frontend/lexer';

function kinds(source: string): string[] {
	return lex(source).map((t) => (t.kind === 'op' || t.kind === 'ident' ? t.text : t.kind));
}

describe('lexer', () => {
	it('lexes identifiers, keywords, and operators', () => {
		expect(kinds('X := Y + 1')).toEqual(['X', ':=', 'Y', '+', 'int', 'newline', 'eof']);
	});

	it('emits indent/dedent for indented blocks', () => {
		const source = 'if (X):\n    Y\nZ\n';
		expect(kinds(source)).toEqual([
			'if', '(', 'X', ')', ':', 'newline',
			'indent', 'Y', 'newline', 'dedent',
			'Z', 'newline', 'eof',
		]);
	});

	it('suppresses newlines inside brackets', () => {
		const source = 'F(\n    1,\n    2)\n';
		expect(kinds(source)).toEqual(['F', '(', 'int', ',', 'int', ')', 'newline', 'eof']);
	});

	it('handles nested dedents', () => {
		const source = 'a:\n    b:\n        c\nd\n';
		expect(kinds(source)).toEqual([
			'a', ':', 'newline',
			'indent', 'b', ':', 'newline',
			'indent', 'c', 'newline',
			'dedent', 'dedent', 'd', 'newline', 'eof',
		]);
	});

	it('skips line and block comments', () => {
		expect(kinds('X # comment\nY')).toEqual(['X', 'newline', 'Y', 'newline', 'eof']);
		expect(kinds('X <# multi\nline #> Y')).toEqual(['X', 'Y', 'newline', 'eof']);
	});

	it('skips comment-only and blank lines without emitting block tokens', () => {
		const source = 'a:\n    b\n\n    # comment\n    c\n';
		expect(kinds(source)).toEqual([
			'a', ':', 'newline',
			'indent', 'b', 'newline', 'c', 'newline',
			'dedent', 'eof',
		]);
	});

	it('lexes numeric literals', () => {
		const tokens = lex('42 1_000 0xFF 0b1010 3.5 1e3 2.5e-2');
		expect(tokens.map((t) => t.value).filter((v) => v !== undefined)).toEqual([
			42, 1000, 255, 10, 3.5, 1000, 0.025,
		]);
		expect(tokens.map((t) => t.kind).slice(0, 7)).toEqual([
			'int', 'int', 'int', 'int', 'float', 'float', 'float',
		]);
	});

	it('does not eat range dots as a float', () => {
		expect(kinds('0..10')).toEqual(['int', '..', 'int', 'newline', 'eof']);
	});

	it('lexes char literals with escapes', () => {
		const tokens = lex("'a' '\\n'");
		expect(tokens[0].kind).toBe('char');
		expect(tokens[0].value).toBe('a');
		expect(tokens[1].value).toBe('\n');
	});

	it('lexes strings with interpolation parts', () => {
		const tokens = lex('"count is {X + 1}, done"');
		expect(tokens[0].kind).toBe('string');
		expect(tokens[0].parts).toEqual([
			expect.objectContaining({ type: 'text', text: 'count is ' }),
			expect.objectContaining({ type: 'interp', text: 'X + 1' }),
			expect.objectContaining({ type: 'text', text: ', done' }),
		]);
	});

	it('handles string escapes', () => {
		const tokens = lex('"a\\nb\\{not interp}"');
		expect(tokens[0].parts).toEqual([
			expect.objectContaining({ type: 'text', text: 'a\nb{not interp}' }),
		]);
	});

	it('tracks spaceBefore for specifier disambiguation', () => {
		const tokens = lex('F<decides> a < b');
		const lt1 = tokens.findIndex((t) => t.text === '<');
		expect(tokens[lt1].spaceBefore).toBe(false);
		const lt2 = tokens.findIndex((t, i) => t.text === '<' && i > lt1);
		expect(tokens[lt2].spaceBefore).toBe(true);
	});

	it('lexes multi-character operators greedily', () => {
		expect(kinds('a := b <= c <> d => e -> f .. g += h')).toEqual([
			'a', ':=', 'b', '<=', 'c', '<>', 'd', '=>', 'e', '->', 'f', '..', 'g', '+=', 'h',
			'newline', 'eof',
		]);
	});

	it('reports unterminated strings', () => {
		expect(() => lex('"abc')).toThrow(/Unterminated string/);
	});

	it('closes all open blocks at end of file', () => {
		expect(kinds('a:\n    b:\n        c')).toEqual([
			'a', ':', 'newline',
			'indent', 'b', ':', 'newline',
			'indent', 'c', 'newline',
			'dedent', 'dedent', 'eof',
		]);
	});
});
