// The builtin documentation is generated from the host's bindings
// registry; these tests keep the two in sync (every export must be
// documented).
import { describe, expect, it } from 'vitest';
import { symbolDocToMarkdown } from '../src/verse';
import { testHost } from './helpers/test-host';

describe('builtin docs generation', () => {
	it('produces a documented entry for every registry module', () => {
		const docs = testHost.docs();
		const documentedPaths = docs.map((moduleDoc) => moduleDoc.path).sort();
		expect(documentedPaths).toEqual([...testHost.registry.modules.keys()].sort());
		for (const moduleDoc of docs) {
			expect(moduleDoc.description, `module ${moduleDoc.path} needs a description`).toBeTruthy();
		}
	});

	it('gives every exported symbol a signature and doc text', () => {
		for (const moduleDoc of testHost.docs()) {
			for (const symbol of moduleDoc.symbols) {
				expect(symbol.signature, `${symbol.name} needs a signature`).toBeTruthy();
				expect(symbol.doc, `${moduleDoc.path}:${symbol.name} needs doc text`).toBeTruthy();
				expect(['function', 'class', 'value', 'enum']).toContain(symbol.kind);
			}
		}
	});

	it('lists the prelude first and marks it implicit', () => {
		const docs = testHost.docs();
		expect(docs[0].path).toBe('/Verse.org/Verse');
		expect(docs[0].implicit).toBe(true);
	});

	it('includes Print in the implicit prelude', () => {
		const index = testHost.symbolIndex();
		const print = index.get('Print');
		expect(print).toBeDefined();
		expect(print.modulePath).toBe('/Verse.org/Verse');
		expect(print.signature).toContain('Print(');
	});

	it('renders hover markdown with signature, docs, and import hint', () => {
		const index = testHost.symbolIndex();

		const sleep = symbolDocToMarkdown(index.get('Sleep'));
		expect(sleep).toContain('Sleep(Seconds: float)<suspends>: void');
		expect(sleep).toContain('using { /Verse.org/Simulation }');

		const abs = symbolDocToMarkdown(index.get('Abs'));
		expect(abs).toContain('**Overloads**');
		expect(abs).toContain('implicitly imported');
	});

	it('reflects registry parameter metadata in signatures', () => {
		const index = testHost.symbolIndex();
		expect(index.get('GetRandomInt').signature).toBe('GetRandomInt(Min: int, Max: int): int');
		expect(index.get('Mod').signature).toBe('Mod(X: int, Y: int)<decides>: int');
		expect(index.get('creative_device').signature).toBe('creative_device := class');
	});
});
