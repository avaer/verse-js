// analysis.test.ts
// IDE language services: hover, go-to-definition, and scope-aware
// completions driven by the semantic checker.

import { describe, expect, it } from 'vitest';
import {
	completionsAt, definitionAt, hoverAt,
} from '../../src/verse/analysis';
import { testHost } from '../helpers/test-host';

const analyzeVerse = (source: string) => testHost.analyze(source);

const SOURCE = [
	'Score : int = 42',                          // 1
	'',                                          // 2
	'Add(A : int, B : int) : int =',             // 3
	'    A + B',                                 // 4
	'',                                          // 5
	'player_stats := class:',                    // 6
	'    var Health : int = 100',                // 7
	'    Heal(Amount : int) : void =',           // 8
	'        set Health += Amount',              // 9
	'',                                          // 10
	'Main() : void =',                           // 11
	'    Total := Add(Score, 8)',                // 12
	'    Doubled := Add(Total, Total)',          // 13
	'    Stats := player_stats{}',               // 14
	'    Stats.Heal(5)',                         // 15
	'    Print("{Doubled}")',                    // 16
	'',                                          // 17
	'Main()',                                    // 18
].join('\n');

/** 1-based {line, col} of the given occurrence of `needle`. */
function posOf(needle: string, occurrence = 1): { line: number; col: number } {
	const lines = SOURCE.split('\n');
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		let idx = lines[i].indexOf(needle);
		while (idx !== -1) {
			count += 1;
			if (count === occurrence) {
				return { line: i + 1, col: idx + 1 };
			}
			idx = lines[i].indexOf(needle, idx + 1);
		}
	}
	throw new Error(`needle not found: ${needle} (occurrence ${occurrence})`);
}

const analysis = analyzeVerse(SOURCE);

describe('analyzeVerse', () => {
	it('produces a checked program with no errors', () => {
		expect(analysis.ok).toBe(true);
		expect(analysis.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(analysis.moduleScope).not.toBeNull();
	});
});

describe('hoverAt', () => {
	it('shows the type of a global used in a function body', () => {
		const pos = posOf('Score, 8');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('Score : int');
		expect(hover?.markdown).toContain('module-level definition');
	});

	it('shows the signature of a user function at a call site', () => {
		const pos = posOf('Add(Score');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('Add(A : int, B : int) : int');
		expect(hover?.markdown).toContain('function');
	});

	it('shows the type of a local variable', () => {
		const pos = posOf('Total, Total');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('Total : int');
		expect(hover?.markdown).toContain('local');
	});

	it('shows method signatures on member access', () => {
		const pos = posOf('Heal(5)');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('Heal(Amount : int)');
		expect(hover?.markdown).toContain('member of player_stats');
	});

	it('shows builtin docs for natives', () => {
		const pos = posOf('Print(');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('Print(');
		expect(hover?.markdown).toContain('builtin');
	});

	it('shows class info when hovering a class name', () => {
		const pos = posOf('player_stats{}');
		const hover = hoverAt(analysis, pos.line, pos.col);
		expect(hover?.markdown).toContain('player_stats');
		expect(hover?.markdown).toContain('class');
	});
});

describe('definitionAt', () => {
	it('resolves a function call to the function definition', () => {
		const pos = posOf('Add(Score');
		const span = definitionAt(analysis, pos.line, pos.col);
		expect(span?.start.line).toBe(3);
	});

	it('resolves a global use to its definition', () => {
		const pos = posOf('Score, 8');
		const span = definitionAt(analysis, pos.line, pos.col);
		expect(span?.start.line).toBe(1);
	});

	it('resolves a local use to its declaration', () => {
		const pos = posOf('Total, Total');
		const span = definitionAt(analysis, pos.line, pos.col);
		expect(span?.start.line).toBe(12);
	});

	it('resolves a method member access to its declaration in the class', () => {
		const pos = posOf('Heal(5)');
		const span = definitionAt(analysis, pos.line, pos.col);
		expect(span?.start.line).toBe(8);
	});

	it('resolves a class name to the class definition', () => {
		const pos = posOf('player_stats{}');
		const span = definitionAt(analysis, pos.line, pos.col);
		expect(span?.start.line).toBe(6);
	});

	it('returns null for natives (no source location)', () => {
		const pos = posOf('Print(');
		expect(definitionAt(analysis, pos.line, pos.col)).toBeNull();
	});
});

describe('completionsAt', () => {
	it('includes locals, globals, functions, classes, and natives inside a body', () => {
		const pos = posOf('Print(');
		const names = completionsAt(analysis, pos.line, pos.col).map((e) => e.name);
		expect(names).toContain('Total');
		expect(names).toContain('Doubled');
		expect(names).toContain('Stats');
		expect(names).toContain('Score');
		expect(names).toContain('Add');
		expect(names).toContain('player_stats');
		expect(names).toContain('Print');
	});

	it('includes params and class members inside a method body', () => {
		const pos = posOf('set Health');
		const entries = completionsAt(analysis, pos.line, pos.col);
		const names = entries.map((e) => e.name);
		expect(names).toContain('Amount');
		expect(names).toContain('Health');
		expect(names).toContain('Heal');
		const health = entries.find((e) => e.name === 'Health');
		expect(health?.kind).toBe('member');
		expect(health?.detail).toContain('var Health : int');
	});

	it('falls back to module scope outside any statement', () => {
		// Line 2 is blank: no enclosing statement.
		const names = completionsAt(analysis, 2, 1).map((e) => e.name);
		expect(names).toContain('Add');
		expect(names).toContain('Score');
		expect(names).toContain('Print');
		expect(names).not.toContain('Total');
	});

	it('reports local variable types in the detail', () => {
		const pos = posOf('Print(');
		const entries = completionsAt(analysis, pos.line, pos.col);
		const total = entries.find((e) => e.name === 'Total');
		expect(total?.detail).toBe('Total : int');
	});
});
