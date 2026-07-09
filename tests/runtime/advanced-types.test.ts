// advanced-types.test.ts
// Phase 4 features: parametric functions/classes (where clauses), type
// aliases, unions, enums, unique/castable classes, type{} values, ?= on
// options, and extension methods.

import { describe, expect, it } from 'vitest';
import { runVerse } from '../../src/verse/pipeline';

async function run(source: string): Promise<string[]> {
	const { output, errors } = await runVerse(source);
	if (errors.length > 0) {
		throw new Error(`Verse run failed: ${errors.join('\n')}\n--- source ---\n${source}`);
	}
	return output;
}

describe('parametric functions', () => {
	it('identity with where clause', async () => {
		expect(await run(`
Identity(X : t where t : type) : t = X
Print("{Identity(42)}")
Print(Identity("hello"))
`)).toEqual(['42', 'hello']);
	});

	it('generic pair helper', async () => {
		expect(await run(`
First(A : t, B : t where t : type) : t = A
Print("{First(1, 2)}")
`)).toEqual(['1']);
	});
});

describe('parametric classes', () => {
	it('generic container class', async () => {
		expect(await run(`
box(t : type) := class:
    Value : t
B := box(int){Value := 9}
Print("{B.Value}")
`)).toEqual(['9']);
	});
});

describe('type aliases', () => {
	it('alias for a primitive and container', async () => {
		expect(await run(`
score := type{int}
Points : score = 100
Print("{Points}")
`)).toEqual(['100']);
	});
});

describe('enums', () => {
	it('enum values, equality, and case', async () => {
		expect(await run(`
direction := enum:
    North
    East
    South
    West
Describe(D : direction) : string =
    case (D):
        direction.North => "up"
        direction.South => "down"
        _ => "sideways"
Print(Describe(direction.North))
Print(Describe(direction.East))
Print(Describe(direction.South))
`)).toEqual(['up', 'sideways', 'down']);
	});
});

describe('castable classes', () => {
	it('upcast and downcast through a hierarchy', async () => {
		expect(await run(`
shape := class:
    Area() : int = 0
circle := class(shape):
    Radius : int = 1
    Area<override>() : int = 3 * Radius * Radius
square := class(shape):
    Side : int = 1
    Area<override>() : int = Side * Side
Shapes : []shape = array{circle{Radius := 2}, square{Side := 3}}
for (S : Shapes):
    if (C := circle[S]):
        Print("circle area {C.Area()}")
    else if (Q := square[S]):
        Print("square area {Q.Area()}")
`)).toEqual(['circle area 12', 'square area 9']);
	});
});

describe('option handling', () => {
	it('?= sets a var only when empty-ish usage works with options', async () => {
		expect(await run(`
MaybeName : ?string = option{"verse"}
if (Name := MaybeName?):
    Print(Name)
Empty : ?string = false
Fallback := if (N := Empty?) then N else "default"
Print(Fallback)
`)).toEqual(['verse', 'default']);
	});
});

describe('extension methods', () => {
	it('extension on int and string', async () => {
		expect(await run(`
(X : int).Doubled() : int = X + X
(S : string).Shout() : string = S + "!"
Print("{(21).Doubled()}")
Print(("hey").Shout())
`)).toEqual(['42', 'hey!']);
	});
});

describe('function values', () => {
	it('functions stored and invoked through variables', async () => {
		expect(await run(`
AddOne(X : int) : int = X + 1
F := AddOne
Print("{F(41)}")
`)).toEqual(['42']);
	});
});

describe('unique classes', () => {
	it('unique instances compare by identity', async () => {
		expect(await run(`
token := class<unique>:
    Label : string = ""
A := token{Label := "a"}
B := token{Label := "a"}
if (A = A):
    Print("same instance equal")
if (A = B):
    Print("different instances equal (wrong)")
else:
    Print("different instances not equal")
`)).toEqual(['same instance equal', 'different instances not equal']);
	});
});

describe('struct value semantics', () => {
	it('copies on assignment (mutating the copy leaves the original)', async () => {
		expect(await run(`
point := struct:
    var X : int = 0
P1 := point{X := 1}
P2 := P1
Print("{P1.X} {P2.X}")
`)).toEqual(['1 1']);
	});
});
