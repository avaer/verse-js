// analysis.test.ts
// Cross-file IDE queries: hover/definition/completions over a workspace
// analysis, where names resolve to declarations in other files.

import { describe, expect, it } from 'vitest';
import { completionsAt, definitionAt, hoverAt } from '../../src/verse/analysis';
import { testHost } from '../helpers/test-host';

const FILES = {
	'lib.verse': `Scale : float = 2.0
Grow(X : float) : float = X * Scale

vec := class:
    X : float = 0.0
    Length() : float = X
`,
	'main.verse': `V := vec{X := 3.0}
L := Grow(V.Length())
Print("{L}")
`,
};

const workspace = testHost.analyzeWorkspace(FILES);
const mainAnalysis = workspace.files.get('main.verse')!;

describe('analyzeWorkspace', () => {
	it('produces an analysis per file over a shared scope', () => {
		expect(workspace.ok).toBe(true);
		expect([...workspace.files.keys()].sort()).toEqual(['lib.verse', 'main.verse']);
		expect(workspace.files.get('lib.verse')!.moduleScope)
			.toBe(mainAnalysis.moduleScope);
	});

	it('go-to-definition on a cross-file function points into the other file', () => {
		// 'Grow(' on line 2 of main.verse.
		const col = FILES['main.verse'].split('\n')[1].indexOf('Grow') + 1;
		const loc = definitionAt(mainAnalysis, 2, col);
		expect(loc?.file).toBe('lib.verse');
		expect(loc?.span.start.line).toBe(2);
	});

	it('go-to-definition on a cross-file class points into the other file', () => {
		const col = FILES['main.verse'].indexOf('vec{') + 1;
		const loc = definitionAt(mainAnalysis, 1, col);
		expect(loc?.file).toBe('lib.verse');
		expect(loc?.span.start.line).toBe(4);
	});

	it('go-to-definition on a member points at its declaring file', () => {
		const col = FILES['main.verse'].split('\n')[1].indexOf('Length') + 1;
		const loc = definitionAt(mainAnalysis, 2, col);
		expect(loc?.file).toBe('lib.verse');
		expect(loc?.span.start.line).toBe(6);
	});

	it('same-file definitions still resolve to the same file', () => {
		const col = FILES['main.verse'].split('\n')[1].indexOf('V.') + 1;
		const loc = definitionAt(mainAnalysis, 2, col);
		expect(loc?.file).toBe('main.verse');
		expect(loc?.span.start.line).toBe(1);
	});

	it('hover resolves types for cross-file symbols', () => {
		const col = FILES['main.verse'].split('\n')[1].indexOf('Grow') + 1;
		const hover = hoverAt(mainAnalysis, 2, col);
		expect(hover?.markdown).toContain('Grow(X : float) : float');
	});

	it('completions include cross-file globals and classes', () => {
		const entries = completionsAt(mainAnalysis, 2, 1);
		const names = entries.map((e) => e.name);
		expect(names).toContain('Grow');
		expect(names).toContain('Scale');
		expect(names).toContain('vec');
	});

	it('per-file diagnostics land on their own analysis', () => {
		const broken = testHost.analyzeWorkspace({
			'good.verse': 'Fine() : int = 1',
			'oops.verse': 'Bad() : int = "string"',
		});
		expect(broken.ok).toBe(true);
		expect(broken.files.get('good.verse')!.diagnostics).toEqual([]);
		const oops = broken.files.get('oops.verse')!.diagnostics;
		expect(oops.some((d) => d.severity === 'error')).toBe(true);
	});
});
