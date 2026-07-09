// rollback-elision.test.ts
// Regression tests for effect-directed transaction elision: read-only
// failure contexts compile without a transaction, so these pin down that
// (a) contexts that DO write still roll back correctly, and (b) read-only
// contexts still produce the right values through the plain fail-check path.

import { describe, expect, it } from 'vitest';
import { createHost } from '../../src/verse/index';

const host = createHost();

async function run(source: string): Promise<{ output: string[]; errors: string[] }> {
	const { output, errors } = await host.execute(source);
	return { output, errors };
}

describe('read-only failure contexts (transaction elided)', () => {
	it('if conditions that only read still gate correctly', async () => {
		const r = await run(`
X : int = 41
if (X > 40, X < 100):
    Print("in range")
else:
    Print("out of range")
if (X > 100):
    Print("wrong")
else:
    Print("right")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['in range', 'right']);
	});

	it('read-only or / not produce the same values as before', async () => {
		const r = await run(`
Lookup(X : int)<decides><computes> : int =
    X > 10
    X * 2
A := Lookup[20] or 0
B := Lookup[5] or 0
Print("{A} {B}")
if (not Lookup[5]):
    Print("not fired")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['40 0', 'not fired']);
	});

	it('read-only loop filters skip without a transaction', async () => {
		const r = await run(`
var Total : int = 0
for (I := 1..10, I > 5):
    set Total += I
Print("{Total}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['40']);
	});

	it('read-only option{} still catches failure', async () => {
		const r = await run(`
Maybe(X : int)<decides><computes> : int =
    X > 0
    X
A := option{Maybe[3]}
B := option{Maybe[-3]}
if (V := A?):
    Print("A = {V}")
if (not B?):
    Print("B empty")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['A = 3', 'B empty']);
	});
});

describe('writing failure contexts (transaction kept)', () => {
	it('rolls back var writes when a later condition fails', async () => {
		const r = await run(`
var Score : int = 10
if (set Score += 100, Score > 1000):
    Print("won")
else:
    Print("lost")
Print("{Score}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['lost', '10']);
	});

	it('rolls back writes made inside a called <decides> function', async () => {
		const r = await run(`
var Hits : int = 0
Bump(X : int)<decides> : int =
    set Hits += 1
    X > 5
    X
if (Bump[3]):
    Print("wrong")
Print("{Hits}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});

	it('or rolls back left-side writes before running the right side', async () => {
		const r = await run(`
var State : int = 0
Try(X : int)<decides> : int =
    set State += X
    X > 100
    X
Result := Try[7] or 42
Print("{Result} {State}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['42 0']);
	});

	it('not rolls back writes even when the operand succeeds', async () => {
		const r = await run(`
var Marks : int = 0
Mark()<decides> : void =
    set Marks += 1
if (not Mark[]):
    Print("wrong")
Print("{Marks}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});

	it('writing loop filters roll back per skipped combination', async () => {
		const r = await run(`
var Seen : int = 0
Pass(I : int)<decides> : int =
    set Seen += 1
    Mod[I, 2] = 0
    I
var Total : int = 0
for (I := 1..6, Pass[I]):
    set Total += I
Print("{Total} {Seen}")
`);
		expect(r.errors).toEqual([]);
		// 2+4+6 = 12; Seen increments only for the 3 passing filters
		// (failing ones roll the increment back).
		expect(r.output).toEqual(['12 3']);
	});

	it('nested read-only context inside a writing condition still journals', async () => {
		// `not (Log > 100)` is read-only (elided); the surrounding clause
		// writes, so its transaction must still roll the increment back.
		const r = await run(`
var Log : int = 0
if (set Log += 1, not (Log > 100), Log > 100):
    Print("outer")
Print("{Log}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});
});

describe('context-local write elision (journal skipped for same-depth locals)', () => {
	it('<decides> function locals compute correctly with elided journaling', async () => {
		const r = await run(`
Sum(N : int)<decides> : int =
    N > 0
    var Acc : int = 0
    for (I := 1..N):
        set Acc += I
    Acc
if (S := Sum[10]):
    Print("{S}")
if (not Sum[-1]):
    Print("failed as expected")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['55', 'failed as expected']);
	});

	it('a var declared outside the condition but written inside still rolls back', async () => {
		const r = await run(`
var Outer : int = 5
if (set Outer += 10, Outer > 100):
    Print("wrong")
Print("{Outer}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['5']);
	});

	it('local declared before an inner failure context rolls back its writes', async () => {
		// Bump's body runs at depth 1; the inner if condition (depth 2)
		// writes Local, declared at depth 1 -> must journal + roll back.
		const r = await run(`
Bump()<decides> : int =
    var Local : int = 1
    if (set Local += 100, Local > 1000):
        Print("wrong")
    Local
if (V := Bump[]):
    Print("{V}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1']);
	});

	it('captured-var writes from a nested function still roll back', async () => {
		const r = await run(`
var Count : int = 0
Outer()<decides> : void =
    Inner() : void =
        set Count += 1
    Inner()
    Count > 100
if (Outer[]):
    Print("wrong")
Print("{Count}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['0']);
	});

	it('loop-iteration redeclaration behaves the same with elision', async () => {
		const r = await run(`
var Kept : int = 0
Check(I : int)<decides> : int =
    var Doubled : int = I * 2
    set Doubled += 1
    Doubled > 5
    Doubled
for (I := 1..4):
    if (V := Check[I]):
        set Kept += V
Print("{Kept}")
`);
		expect(r.errors).toEqual([]);
		// I=3 -> 7, I=4 -> 9; earlier iterations fail.
		expect(r.output).toEqual(['16']);
	});

	it('condition mutating only its own local compiles and gates correctly', async () => {
		// The helper's writes are all to its own local, so the failed call
		// needs no rollback: the variable dies with the failed frame.
		const r = await run(`
Big(V : int)<decides> : int =
    var T : int = V
    set T += 5
    T > 10
    T
Classify(X : int) : string =
    if (Big[X]):
        "big"
    else:
        "small"
Print(Classify(20))
Print(Classify(1))
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['big', 'small']);
	});
});
