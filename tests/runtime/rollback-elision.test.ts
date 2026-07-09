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
