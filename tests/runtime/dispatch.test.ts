// dispatch.test.ts
// Member access / method dispatch through the per-site inline caches:
// polymorphic call sites (cache miss + refill), overrides, extension
// methods, native value methods, and struct field reads must all behave
// exactly as the generic lookup path did.

import { describe, expect, it } from 'vitest';
import { testHost } from '../helpers/test-host';

async function run(source: string): Promise<{ output: string[]; errors: string[] }> {
	const { output, errors } = await testHost.execute(source);
	return { output, errors };
}

describe('method dispatch through inline caches', () => {
	it('polymorphic call site: two classes with overrides through one site', async () => {
		const r = await run(`
animal := class:
    Speak() : string = "..."
dog := class(animal):
    Speak<override>() : string = "woof"
cat := class(animal):
    Speak<override>() : string = "meow"
Describe(A : animal) : string = A.Speak()
D := dog{}
C := cat{}
Print(Describe(D))
Print(Describe(C))
Print(Describe(D))
Print(Describe(C))
`);
		expect(r.errors).toEqual([]);
		// Alternating receivers exercise the cache-miss path every call.
		expect(r.output).toEqual(['woof', 'meow', 'woof', 'meow']);
	});

	it('inherited (non-overridden) methods dispatch correctly', async () => {
		const r = await run(`
base := class:
    Name() : string = "base"
    Greet() : string = "hi from {Name()}"
derived := class(base):
    Name<override>() : string = "derived"
B := base{}
D := derived{}
Print(B.Greet())
Print(D.Greet())
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['hi from base', 'hi from derived']);
	});

	it('field and method with the same site alternating classes', async () => {
		// Same member-read site sees a field on one class and a method
		// result on another type entirely (option through ?).
		const r = await run(`
counter := class:
    var N : int = 0
    Bump() : int =
        set N += 1
        N
A := counter{}
B := counter{}
Print("{A.Bump()} {A.Bump()} {B.Bump()} {A.N} {B.N}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1 2 1 2 1']);
	});

	it('extension methods still resolve after class methods miss', async () => {
		const r = await run(`
point := class:
    X : int = 1
    Y : int = 2
(P : point).Sum() : int = P.X + P.Y
Q := point{X := 3, Y := 4}
Print("{Q.Sum()}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['7']);
	});

	it('native value methods (task.Await) still work', async () => {
		const r = await run(`
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Work()<suspends> : int =
    Sleep(0.0)
    42
demo_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Work() }
        V := T.Await()
        Print("got {V}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['got 42']);
	});

	it('struct field reads keep copy semantics', async () => {
		const r = await run(`
vec := struct:
    X : int = 0
    Y : int = 0
Flip(V : vec) : vec = vec{X := V.Y, Y := V.X}
A := vec{X := 1, Y := 2}
B := Flip(A)
Print("{A.X} {A.Y} {B.X} {B.Y}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['1 2 2 1']);
	});

	it('bare method reads (obj.Method as value) still bind the receiver', async () => {
		const r = await run(`
greeter := class:
    Who : string = "world"
    Greet() : string = "hello {Who}"
G := greeter{Who := "verse"}
F := G.Greet
Print(F())
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['hello verse']);
	});

	it('array pseudo-methods through a call site (Length/Slice)', async () => {
		const r = await run(`
Xs := array{1, 2, 3, 4}
Print("{Xs.Length}")
if (S := Xs.Slice[1, 3]):
    Print("{S.Length}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['4', '2']);
	});

	it('fields holding function values are called, not treated as methods', async () => {
		const r = await run(`
Doubler(X : int) : int = X * 2
holder := class:
    F : type{_(:int) : int} = Doubler
H := holder{}
Print("{H.F(21)}")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['42']);
	});
});
