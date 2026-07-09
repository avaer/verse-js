// recovery.test.ts
// Error-recovering parse: multiple syntax errors reported per file, and
// valid statements around them still parse.

import { describe, expect, it } from 'vitest';
import { parseVerseTolerant } from '../../src/verse/frontend/parser';

describe('parseVerseTolerant', () => {
	it('reports multiple top-level syntax errors', () => {
		const { errors } = parseVerseTolerant(`X := 1
Y := := 2
Z := 3
W := ((4
V := 5
`);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it('keeps parsing statements after an error', () => {
		const { program, errors } = parseVerseTolerant(`A := 1
B := := oops
C := 3
`);
		expect(errors).toHaveLength(1);
		const names = program.body
			.filter((e) => e.kind === 'Definition')
			.map((e) => (e as { name: string }).name);
		expect(names).toContain('A');
		expect(names).toContain('C');
	});

	it('recovers across indented blocks', () => {
		const { program, errors } = parseVerseTolerant(`Broken() : void =
    set = 5
    Print("bad")
Fine() : void =
    Print("ok")
`);
		expect(errors.length).toBeGreaterThanOrEqual(1);
		const names = program.body
			.filter((e) => e.kind === 'FunctionDef')
			.map((e) => (e as { name: string }).name);
		expect(names).toContain('Fine');
	});

	it('returns a single error for unterminated strings (lex error)', () => {
		const { errors } = parseVerseTolerant('X := "unterminated');
		expect(errors).toHaveLength(1);
	});
});
