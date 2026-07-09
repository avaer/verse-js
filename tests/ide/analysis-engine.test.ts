// analysis-engine.test.ts
// The IDE's worker-hosted analysis engine and its request protocol:
// workspace snapshots, cached re-analysis, last-good fallback while a file
// has a syntax error, and the dispatcher the worker + same-thread fallback
// share. (The Web Worker transport itself is covered by the E2E suite.)

import { describe, expect, it } from 'vitest';
import {
	AnalysisEngine, AnalysisRequest, dispatchAnalysisRequest,
} from '../../src/ide/analysis-engine';
import { createTestHost } from '../helpers/test-host';

const FILES = {
	'lib.verse': `Scale : float = 2.0
Grow(X : float) : float = X * Scale
`,
	'main.verse': `L := Grow(3.0)
Print("{L}")
`,
};

function makeEngine(): AnalysisEngine {
	const engine = new AnalysisEngine(createTestHost());
	engine.setFiles(FILES);
	return engine;
}

describe('AnalysisEngine', () => {
	it('reports no diagnostics for a clean workspace', () => {
		expect(makeEngine().diagnostics()).toEqual([]);
	});

	it('tags diagnostics with the offending file', () => {
		const engine = makeEngine();
		engine.setFiles({ ...FILES, 'main.verse': 'L := Grow("nope")\n' });
		const diagnostics = engine.diagnostics();
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.every((d) => d.file === 'main.verse')).toBe(true);
	});

	it('answers hover with a serializable markdown payload', () => {
		const col = FILES['main.verse'].indexOf('Grow') + 1;
		const hover = makeEngine().hover('main.verse', 1, col);
		expect(hover?.markdown).toContain('Grow(X : float) : float');
		// The worker structured-clones results; no class instances allowed.
		expect(JSON.parse(JSON.stringify(hover))).toEqual(hover);
	});

	it('resolves cross-file definitions', () => {
		const col = FILES['main.verse'].indexOf('Grow') + 1;
		const location = makeEngine().definition('main.verse', 1, col);
		expect(location?.file).toBe('lib.verse');
		expect(location?.span.start.line).toBe(2);
	});

	it('includes cross-file symbols in completions', () => {
		const entries = makeEngine().completions('main.verse', 2, 1);
		const names = entries.map((e) => e.name);
		expect(names).toContain('Grow');
		expect(names).toContain('Scale');
	});

	it('keeps serving the last good analysis while a file has a syntax error', () => {
		const engine = makeEngine();
		// Prime the last-good cache, then break main.verse mid-edit.
		expect(engine.diagnostics()).toEqual([]);
		engine.setFiles({ ...FILES, 'main.verse': 'L := Grow(\n' });
		expect(engine.diagnostics().length).toBeGreaterThan(0);
		const col = FILES['main.verse'].indexOf('Grow') + 1;
		expect(engine.hover('main.verse', 1, col)?.markdown).toContain('Grow');
	});

	it('re-analyzes only when the sources changed', () => {
		const engine = makeEngine();
		const first = engine.diagnostics();
		// Same version: the cached analysis object is reused.
		expect(engine.diagnostics()).toBe(first);
	});
});

describe('dispatchAnalysisRequest', () => {
	it('routes every protocol method to the engine', () => {
		const engine = makeEngine();
		const call = (method: AnalysisRequest['method'], args: unknown[] = []) =>
			dispatchAnalysisRequest(engine, { id: 1, method, args });

		expect(call('setFiles', [FILES])).toBeUndefined();
		expect(call('diagnostics')).toEqual([]);
		const col = FILES['main.verse'].indexOf('Grow') + 1;
		expect((call('hover', ['main.verse', 1, col]) as { markdown: string }).markdown)
			.toContain('Grow');
		expect((call('definition', ['main.verse', 1, col]) as { file: string }).file)
			.toBe('lib.verse');
		expect((call('completions', ['main.verse', 2, 1]) as { name: string }[])
			.map((e) => e.name)).toContain('Grow');
	});
});
