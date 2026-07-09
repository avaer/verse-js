// workspace.test.ts
// Multi-file compilation: shared module scope across files, entry-file run
// semantics, cross-file duplicate detection, and file-tagged diagnostics.

import { describe, expect, it } from 'vitest';
import { MemorySourceFs } from '../../src/verse/vfs';
import { testHost } from '../helpers/test-host';

describe('cross-file references', () => {
	it('calls functions defined in another file', async () => {
		const result = await testHost.executeWorkspace({
			'lib.verse': 'Double(X : int) : int = X * 2',
			'main.verse': 'Print("{Double(21)}")',
		}, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['42']);
	});

	it('works regardless of file order', async () => {
		const result = await testHost.executeWorkspace({
			'a-main.verse': 'Print("{Triple(5)}")',
			'z-lib.verse': 'Triple(X : int) : int = X * 3',
		}, { entry: 'a-main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['15']);
	});

	it('uses classes, enums, and extension methods across files', async () => {
		const result = await testHost.executeWorkspace({
			'shapes.verse': `
shape := class:
    Sides : int = 0
    Describe() : string = "shape with {Sides} sides"

suit := enum:
    Hearts
    Spades

(S : string).Shout() : string = "{S}!"
`,
			'main.verse': `
Sq := shape{Sides := 4}
Print(Sq.Describe())
MySuit := suit.Spades
if (MySuit = suit.Spades):
    Print("spades")
Print("hi".Shout())
`,
		}, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['shape with 4 sides', 'spades', 'hi!']);
	});

	it('reads globals defined in another file', async () => {
		const result = await testHost.executeWorkspace({
			'config.verse': 'MaxPlayers : int = 8',
			'main.verse': 'Print("{MaxPlayers}")',
		}, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['8']);
	});
});

describe('entry-file run semantics', () => {
	const FILES = {
		'lib.verse': `
Answer : int = 42
Print("lib ran")
`,
		'main.verse': 'Print("main {Answer}")',
	};

	it('runs only the entry file top-level statements', async () => {
		const result = await testHost.executeWorkspace(FILES, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		// lib.verse's Print does not run, but its global initialized.
		expect(result.output).toEqual(['main 42']);
	});

	it('a different entry runs that file instead', async () => {
		const result = await testHost.executeWorkspace(FILES, { entry: 'lib.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['lib ran']);
	});

	it('no entry runs every file in order', async () => {
		const result = await testHost.executeWorkspace(FILES);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['lib ran', 'main 42']);
	});

	it('runs only entry-point classes from the entry file', async () => {
		const result = await testHost.executeWorkspace({
			'device-a.verse': `
using { /Fortnite.com/Devices }
a_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Print("device A")
`,
			'device-b.verse': `
using { /Fortnite.com/Devices }
b_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Print("device B")
`,
		}, { entry: 'device-b.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['device B']);
	});

	it('entry-file functions can call into library entry classes code paths', async () => {
		// A library device class is still instantiable from the entry file.
		const result = await testHost.executeWorkspace({
			'lib.verse': `
greeter := class:
    Greet(Name : string) : string = "hello {Name}"
`,
			'main.verse': `
G := greeter{}
Print(G.Greet("workspace"))
`,
		}, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['hello workspace']);
	});
});

describe('workspace diagnostics', () => {
	it('flags cross-file duplicate definitions with both files', () => {
		// Same-name functions become overloads; classes must be unique.
		const outcome = testHost.compileWorkspace({
			'first.verse': 'thing := class {}',
			'second.verse': 'thing := class {}',
		});
		expect(outcome.ok).toBe(true); // non-strict compiles keep going
		const dup = outcome.diagnostics.find((d) => d.code === 'duplicate-definition');
		expect(dup).toBeDefined();
		expect(dup?.file).toBe('second.verse');
		expect(dup?.message).toContain("Duplicate definition of 'thing'");
		expect(dup?.message).toContain('already defined in first.verse');
	});

	it('strict mode fails on cross-file duplicates', () => {
		const outcome = testHost.compileWorkspace({
			'first.verse': 'X : int = 1',
			'second.verse': 'X : int = 2',
		}, { strict: true });
		expect(outcome.ok).toBe(false);
	});

	it('tags syntax errors with their file', () => {
		const outcome = testHost.compileWorkspace({
			'good.verse': 'Print("fine")',
			'bad.verse': 'Fn( := broken',
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.diagnostics.length).toBeGreaterThan(0);
		expect(outcome.diagnostics.every((d) => d.file === 'bad.verse')).toBe(true);
	});

	it('tags sema errors with their file', () => {
		const outcome = testHost.compileWorkspace({
			'ok.verse': 'Print("fine")',
			'broken.verse': 'Bad() : int = "not an int"',
		});
		expect(outcome.ok).toBe(true);
		const error = outcome.diagnostics.find((d) => d.severity === 'error');
		expect(error?.file).toBe('broken.verse');
	});

	it('records declFile on cross-file bindings for go-to-definition', () => {
		const outcome = testHost.compileWorkspace({
			'lib.verse': 'Quadruple(X : int) : int = X * 4',
			'main.verse': 'Print("{Quadruple(2)}")',
		});
		if (!outcome.ok) {
			throw new Error('compile failed');
		}
		const binding = outcome.check.moduleScope.lookup('Quadruple');
		expect(binding?.declFile).toBe('lib.verse');
	});
});

describe('workspace via MemorySourceFs', () => {
	it('compiles and runs from a mutable filesystem', async () => {
		const fs = new MemorySourceFs({ 'main.verse': 'Print("{Value}")' });
		fs.writeFile('lib.verse', 'Value : int = 7');
		const result = await testHost.executeWorkspace(fs, { entry: 'main.verse' });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['7']);
	});
});
