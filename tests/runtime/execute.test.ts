// execute.test.ts
// End-to-end conformance tests for the new pipeline: compile Verse source
// and check printed output.

import { describe, expect, it } from 'vitest';
import { runVerse } from '../../src/verse/pipeline';

async function run(source: string): Promise<string[]> {
	const { output, errors } = await runVerse(source);
	if (errors.length > 0) {
		throw new Error(`Verse run failed: ${errors.join('\n')}\n--- source ---\n${source}`);
	}
	return output;
}

describe('basics', () => {
	it('prints literals and interpolation', async () => {
		expect(await run(`
Print("Hello, world!")
X := 42
Print("X is {X}")
`)).toEqual(['Hello, world!', 'X is 42']);
	});

	it('arithmetic', async () => {
		expect(await run(`
Print("{1 + 2 * 3}")
Print("{(1 + 2) * 3}")
Print("{10 - 3 - 2}")
Print("{2.5 + 0.5}")
`)).toEqual(['7', '9', '5', '3']);
	});

	it('int division produces rationals and is failable', async () => {
		expect(await run(`
if (A := 7 / 2):
    Print("{A}")
if (B := 6 / 2):
    Print("{B}")
X := 0
if (C := 6 / X):
    Print("unreachable")
else:
    Print("div by zero")
`)).toEqual(['7/2', '3', 'div by zero']);
	});

	it('var and set', async () => {
		expect(await run(`
var X : int = 1
set X = 5
set X += 2
Print("{X}")
`)).toEqual(['7']);
	});

	it('string operations', async () => {
		expect(await run(`
A := "foo"
B := "bar"
C := A + B
Print(C)
Print("{C.Length}")
`)).toEqual(['foobar', '6']);
	});
});

describe('failure contexts', () => {
	it('if with comparison', async () => {
		expect(await run(`
X := 5
if (X > 3):
    Print("big")
else:
    Print("small")
`)).toEqual(['big']);
	});

	it('if with multiple conditions', async () => {
		expect(await run(`
X := 5
Y := 10
if (X > 3, Y > 3):
    Print("both")
if (X > 3, Y > 100):
    Print("nope")
else:
    Print("not both")
`)).toEqual(['both', 'not both']);
	});

	it('rollback of var mutation on failure', async () => {
		expect(await run(`
var X : int = 1
if (set X = 99, X > 100):
    Print("unreachable")
Print("{X}")
`)).toEqual(['1']);
	});

	it('decides functions and query', async () => {
		expect(await run(`
IsBig(X : int)<decides> : void =
    X > 10
if (IsBig[20]):
    Print("20 is big")
if (not IsBig[5]):
    Print("5 is not big")
`)).toEqual(['20 is big', '5 is not big']);
	});

	it('or / and expressions', async () => {
		expect(await run(`
X := 5
if (X > 10 or X > 3):
    Print("or works")
if (X > 3 and X < 10):
    Print("and works")
`)).toEqual(['or works', 'and works']);
	});

	it('option types and query operator', async () => {
		expect(await run(`
MaybeX : ?int = option{42}
if (X := MaybeX?):
    Print("got {X}")
Nothing : ?int = false
if (Y := Nothing?):
    Print("unreachable")
else:
    Print("empty")
`)).toEqual(['got 42', 'empty']);
	});
});

describe('control flow', () => {
	it('for over range', async () => {
		expect(await run(`
for (I := 0..3):
    Print("{I}")
`)).toEqual(['0', '1', '2', '3']);
	});

	it('for over array with result collection', async () => {
		expect(await run(`
Doubled := for (X := array{1, 2, 3}):
    X * 2
for (D : Doubled):
    Print("{D}")
`)).toEqual(['2', '4', '6']);
	});

	it('for with filter', async () => {
		expect(await run(`
for (I := 0..10, I > 7):
    Print("{I}")
`)).toEqual(['8', '9', '10']);
	});

	it('loop with break', async () => {
		expect(await run(`
var I : int = 0
loop:
    set I += 1
    if (I >= 3):
        break
Print("{I}")
`)).toEqual(['3']);
	});

	it('case expression', async () => {
		expect(await run(`
Describe(X : int) : string =
    case (X):
        1 => "one"
        2 => "two"
        _ => "many"
Print(Describe(1))
Print(Describe(2))
Print(Describe(9))
`)).toEqual(['one', 'two', 'many']);
	});

	it('defer runs on scope exit in reverse order', async () => {
		expect(await run(`
Go() : void =
    defer:
        Print("first deferred")
    defer:
        Print("second deferred")
    Print("body")
Go()
`)).toEqual(['body', 'second deferred', 'first deferred']);
	});
});

describe('functions', () => {
	it('recursion (fib)', async () => {
		expect(await run(`
Fib(N : int) : int =
    if (N < 2):
        N
    else:
        Fib(N - 1) + Fib(N - 2)
Print("{Fib(10)}")
`)).toEqual(['55']);
	});

	it('default and named parameters', async () => {
		expect(await run(`
Greet(Name : string, ?Greeting : string = "Hello") : void =
    Print("{Greeting}, {Name}!")
Greet("World")
Greet("Verse", ?Greeting := "Hi")
`)).toEqual(['Hello, World!', 'Hi, Verse!']);
	});

	it('function values and lambdas', async () => {
		expect(await run(`
Apply(F : type{_(:int) : int}, X : int) : int =
    F(X)
Double(X : int) : int = X * 2
Print("{Apply(Double, 21)}")
`)).toEqual(['42']);
	});

	it('overloading by arity', async () => {
		expect(await run(`
Add(A : int, B : int) : int = A + B
Add(A : int, B : int, C : int) : int = A + B + C
Print("{Add(1, 2)}")
Print("{Add(1, 2, 3)}")
`)).toEqual(['3', '6']);
	});
});

describe('containers', () => {
	it('arrays: index, length, concat', async () => {
		expect(await run(`
A := array{10, 20, 30}
if (X := A[1]):
    Print("{X}")
Print("{A.Length}")
B := A + array{40}
Print("{B.Length}")
`)).toEqual(['20', '3', '4']);
	});

	it('array index out of bounds fails', async () => {
		expect(await run(`
A := array{1}
if (X := A[5]):
    Print("unreachable")
else:
    Print("out of bounds")
`)).toEqual(['out of bounds']);
	});

	it('maps', async () => {
		expect(await run(`
M := map{"a" => 1, "b" => 2}
if (V := M["a"]):
    Print("{V}")
if (V := M["missing"]):
    Print("unreachable")
else:
    Print("no entry")
`)).toEqual(['1', 'no entry']);
	});

	it('map iteration', async () => {
		expect(await run(`
M := map{1 => "one", 2 => "two"}
for (Key -> Value : M):
    Print("{Key}: {Value}")
`)).toEqual(['1: one', '2: two']);
	});

	it('tuples', async () => {
		expect(await run(`
Pair := (1, "one")
Print("{Pair(0)}")
Print("{Pair(1)}")
`)).toEqual(['1', 'one']);
	});

	it('var arrays with element assignment', async () => {
		expect(await run(`
var A : []int = array{1, 2, 3}
if (set A[1] = 99):
    Print("set ok")
if (X := A[1]):
    Print("{X}")
`)).toEqual(['set ok', '99']);
	});
});

describe('classes', () => {
	it('class with fields and methods', async () => {
		expect(await run(`
counter := class:
    var Count : int = 0
    Increment() : void =
        set Count += 1
    Get() : int = Count
C := counter{}
C.Increment()
C.Increment()
Print("{C.Get()}")
`)).toEqual(['2']);
	});

	it('archetype field values', async () => {
		expect(await run(`
point := class:
    X : int
    Y : int
P := point{X := 3, Y := 4}
Print("{P.X + P.Y}")
`)).toEqual(['7']);
	});

	it('inheritance and override', async () => {
		expect(await run(`
animal := class:
    Speak() : string = "..."
dog := class(animal):
    Speak<override>() : string = "Woof"
D := dog{}
Print(D.Speak())
A : animal = D
Print(A.Speak())
`)).toEqual(['Woof', 'Woof']);
	});

	it('casting with []', async () => {
		expect(await run(`
animal := class:
    Name : string = "generic"
dog := class(animal):
    Trick() : string = "sit"
MakeDog() : animal = dog{}
A := MakeDog()
if (D := dog[A]):
    Print(D.Trick())
`)).toEqual(['sit']);
	});

	it('struct copy semantics', async () => {
		expect(await run(`
vec := struct:
    X : int = 0
V1 := vec{X := 1}
V2 := V1
Print("{V2.X}")
`)).toEqual(['1']);
	});

	it('interfaces', async () => {
		expect(await run(`
speaker := interface:
    Speak() : string
robot := class(speaker):
    Speak<override>() : string = "beep"
R := robot{}
S : speaker = R
Print(S.Speak())
`)).toEqual(['beep']);
	});
});

describe('enums', () => {
	it('enum values and comparison', async () => {
		expect(await run(`
direction := enum:
    North
    South
D := direction.North
if (D = direction.North):
    Print("north")
`)).toEqual(['north']);
	});
});

describe('concurrency', () => {
	it('spawn and Await', async () => {
		expect(await run(`
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Work()<suspends> : int =
    Sleep(0.0)
    42
Main()<suspends> : void =
    X := spawn{ Work() }
    R := X.Await()
    Print("{R}")
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Main()
`)).toEqual(['42']);
	});

	it('race returns the winner', async () => {
		expect(await run(`
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
Fast()<suspends> : string =
    Sleep(0.0)
    "fast"
Slow()<suspends> : string =
    Sleep(1.0)
    "slow"
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Winner := race:
            Fast()
            Slow()
        Print(Winner)
`)).toEqual(['fast']);
	});

	it('sync waits for all', async () => {
		expect(await run(`
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
A()<suspends> : int =
    Sleep(0.0)
    1
B()<suspends> : int =
    2
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Results := sync:
            A()
            B()
        Print("{Results(0) + Results(1)}")
`)).toEqual(['3']);
	});

	it('events signal across tasks', async () => {
		expect(await run(`
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
my_device := class(creative_device):
    var Ready : event(int) = event(int){}
    Waiter()<suspends> : void =
        X := Ready.Await()
        Print("got {X}")
    OnBegin<override>()<suspends> : void =
        T := spawn{ Waiter() }
        Sleep(0.0)
        Ready.Signal(7)
        T.Await()
`)).toEqual(['got 7']);
	});
});

describe('device entry point', () => {
	it('runs OnBegin of creative_device subclasses', async () => {
		expect(await run(`
using { /Fortnite.com/Devices }
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Print("device started")
`)).toEqual(['device started']);
	});
});

describe('extension methods', () => {
	it('calls extension methods on values', async () => {
		expect(await run(`
(X : int).Squared() : int = X * X
Print("{(7).Squared()}")
`)).toEqual(['49']);
	});
});

describe('builtins', () => {
	it('math functions', async () => {
		expect(await run(`
Print("{Abs(-5)}")
Print("{Floor(2.7)}")
Print("{Ceil(2.1)}")
Print("{Min(3, 7)}")
Print("{Max(3, 7)}")
Print("{Clamp(12, 0, 10)}")
`)).toEqual(['5', '2', '3', '3', '7', '10']);
	});

	it('failable builtins', async () => {
		expect(await run(`
if (R := Mod[7, 3]):
    Print("{R}")
if (R := Mod[7, 0]):
    Print("unreachable")
else:
    Print("div by zero")
`)).toEqual(['1', 'div by zero']);
	});

	it('ToString and Concatenate', async () => {
		expect(await run(`
Print(ToString(42))
Print(Concatenate("foo", "bar"))
`)).toEqual(['42', 'foobar']);
	});

	it('string helpers', async () => {
		expect(await run(`
Print(ToUpper("verse"))
Print(Join(Split("a,b,c", ","), "-"))
Print(Reverse("abc"))
if (Contains["hello", "ell"]):
    Print("contains works")
`)).toEqual(['VERSE', 'a-b-c', 'cba', 'contains works']);
	});

	it('colors module', async () => {
		expect(await run(`
using { /Verse.org/Colors }
Print(Red)
if (C := MakeColorFromHex["FF8800"]):
    Print(C)
`)).toEqual(['#FF0000', '#FF8800']);
	});
});
