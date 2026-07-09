// cow.test.ts
// Copy-on-write appends: `set X += array{...}` mutates in place while the
// container is provably unaliased, and falls back to copying once a second
// reference exists. These tests pin the aliasing semantics (value semantics
// preserved) and the journal integration (rollback restores the length).

import { describe, expect, it } from 'vitest';
import { createHost } from '../../src/verse/index';
import { isShared, markShared } from '../../src/verse/runtime/values';

const host = createHost();

async function run(source: string): Promise<{ output: string[]; errors: string[] }> {
	const { output, errors } = await host.execute(source);
	return { output, errors };
}

describe('uniqueness infrastructure', () => {
	it('markShared/isShared track arrays and maps, ignore scalars', () => {
		const arr: number[] = [1, 2];
		expect(isShared(arr)).toBe(false);
		markShared(arr);
		expect(isShared(arr)).toBe(true);
		// No-ops for non-containers (must not throw).
		markShared(3);
		markShared('s');
		markShared(undefined);
	});
});

describe('copy-on-write array appends', () => {
	it('aliased target still copies: alias keeps the old contents', async () => {
		const r = await run(`
var X : []int = array{1, 2}
Y := X
set X += array{3}
Print("{X.Length} {Y.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['3 2']);
	});

	it('alias created after appends sees the appended contents, later appends copy', async () => {
		// Inside a function body so the alias is created between appends
		// (top-level definitions all initialize before statements run).
		const r = await run(`
Demo() : void =
    var X : []int = array{}
    set X += array{1}
    set X += array{2}
    Y := X
    set X += array{3}
    Print("{X.Length} {Y.Length}")
Demo()
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['3 2']);
	});

	it('unshared append inside a failing condition rolls back the length', async () => {
		const r = await run(`
var X : []int = array{1}
if (set X += array{2, 3}, X.Length > 10):
    Print("wrong")
Print("{X.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1']);
	});

	it('append inside a succeeding condition keeps the elements', async () => {
		const r = await run(`
var X : []int = array{1}
if (set X += array{2, 3}, X.Length = 3):
    Print("grew")
Print("{X.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['grew', '3']);
	});

	it('value stored into a container then appended still copies', async () => {
		const r = await run(`
var Inner : []int = array{1}
Outer := array{Inner}
set Inner += array{2}
if (First := Outer[0]):
    Print("{Inner.Length} {First.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 1']);
	});

	it('value stored into a class field then appended still copies', async () => {
		const r = await run(`
holder := class:
    var Items : []int = array{}
var X : []int = array{1}
H := holder{Items := X}
set X += array{2}
Print("{X.Length} {H.Items.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 1']);
	});

	it('value stored into an option then appended still copies', async () => {
		const r = await run(`
var X : []int = array{1}
O := option{X}
set X += array{2}
if (Inside := O?):
    Print("{X.Length} {Inside.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 1']);
	});

	it('appending a variable RHS keeps the RHS unchanged', async () => {
		const r = await run(`
var X : []int = array{1}
var Y : []int = array{10, 20}
set X += Y
Print("{X.Length} {Y.Length}")
set X += X
Print("{X.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['3 2', '6']);
	});

	it('field append through Self mutates only that instance', async () => {
		// (Named `sack` because `bag` is a reserved word.)
		const r = await run(`
sack := class:
    var Items : []int = array{}
    Add(N : int) : void =
        set Items += array{N}
A := sack{}
B := sack{}
A.Add(1)
A.Add(2)
B.Add(9)
Print("{A.Items.Length} {B.Items.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 1']);
	});

	it('100k appends complete fast (smoke: in-place, not quadratic)', async () => {
		const start = Date.now();
		const r = await run(`
var X : []int = array{}
for (I := 1..100000):
    set X += array{I}
Print("{X.Length}")
`);
		const elapsed = Date.now() - start;
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['100000']);
		// Quadratic copying took multiple seconds; in-place is well under 1s.
		expect(elapsed).toBeLessThan(3000);
	});
});

describe('copy-on-write map merges', () => {
	it('aliased map target still copies on merge', async () => {
		const r = await run(`
var M : [string]int = map{"a" => 1}
N := M
set M += map{"b" => 2}
Print("{M.Length} {N.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 1']);
	});

	it('unshared map merge inside a failing condition rolls back entries', async () => {
		const r = await run(`
var M : [string]int = map{"a" => 1}
if (set M += map{"b" => 2, "a" => 99}, M.Length > 10):
    Print("wrong")
if (A := M["a"]):
    Print("{M.Length} {A}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1 1']);
	});

	it('unshared map merge overwrites and adds in place', async () => {
		const r = await run(`
var M : [string]int = map{"a" => 1}
set M += map{"b" => 2, "a" => 10}
if (A := M["a"], B := M["b"]):
    Print("{M.Length} {A} {B}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['2 10 2']);
	});
});
