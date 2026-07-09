// for-loops.test.ts
// Pins down for-loop semantics after the lazy-range-generator optimization:
// `for (I := lo..hi)` iterates numerically without materializing an array,
// so these tests cover ranges, filters, nesting, break, and results.

import { describe, expect, it } from 'vitest';
import { createHost } from '../../src/verse/index';

const host = createHost();

async function run(source: string): Promise<{ output: string[]; errors: string[] }> {
	const { output, errors } = await host.execute(source);
	return { output, errors };
}

describe('range generators', () => {
	it('iterates an ascending range inclusively', async () => {
		const r = await run(`
var Total : int = 0
for (I := 1..5):
    set Total += I
Print("{Total}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['15']);
	});

	it('an empty (descending) range runs zero iterations', async () => {
		const r = await run(`
var Count : int = 0
for (I := 5..1):
    set Count += 1
Print("{Count}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});

	it('range bounds are arbitrary expressions evaluated once', async () => {
		const r = await run(`
Low() : int = 2
var Sum : int = 0
for (I := Low()..2 + 2):
    set Sum += I
Print("{Sum}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['9']);
	});

	it('nested ranges form a cartesian product', async () => {
		const r = await run(`
var Cells : int = 0
for (I := 1..3, J := 1..4):
    set Cells += 1
Print("{Cells}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['12']);
	});

	it('a range generator mixed with an array generator', async () => {
		const r = await run(`
Names : []string = array{"a", "b"}
var Combos : int = 0
for (I := 1..3, N : Names):
    set Combos += 1
Print("{Combos}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['6']);
	});

	it('break exits a range loop early', async () => {
		const r = await run(`
var Last : int = 0
for (I := 1..100):
    if (I > 4):
        break
    set Last = I
Print("{Last}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['4']);
	});

	it('for over a range as an expression collects body results', async () => {
		const r = await run(`
Squares := for (I := 1..4):
    I * I
if (First := Squares[0], Last := Squares[3]):
    Print("{First} {Last}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1 16']);
	});

	it('filters apply per range element', async () => {
		const r = await run(`
var Evens : int = 0
for (I := 1..10, Mod[I, 2] = 0):
    set Evens += 1
Print("{Evens}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['5']);
	});

	it('a failing range bound produces zero iterations', async () => {
		// Limit[5] fails, so the range never yields: the loop body never
		// runs and the surrounding function still succeeds with Count = 0.
		const r = await run(`
Limit(X : int)<decides><computes> : int =
    X > 100
    X
CountUp()<decides> : int =
    var Count : int = 0
    for (I := 1..Limit[5]):
        set Count += 1
    Count
Result := CountUp[] or -1
Print("{Result}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});

	it('a large range does not materialize (smoke: 1M iterations complete)', async () => {
		const r = await run(`
var Total : int = 0
for (I := 1..1000000):
    set Total += 1
Print("{Total}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1000000']);
	});
});

describe('non-range generators still work', () => {
	it('array and map iteration are unchanged', async () => {
		const r = await run(`
Items : []int = array{3, 1, 4}
var Sum : int = 0
for (X : Items):
    set Sum += X
M : [string]int = map{"a" => 1, "b" => 2}
var MapSum : int = 0
for (K -> V : M):
    set MapSum += V
Print("{Sum} {MapSum}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['8 3']);
	});
});
