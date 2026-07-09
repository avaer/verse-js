// Parser conformance across the core Verse grammar.
import { describe, expect, it } from 'vitest';
import { parseVerse } from '../../src/verse/frontend/parser';
import {
	ClassDef, Definition, EnumDef, Expr, ForExpr, FunctionDef, IfExpr,
	ModuleDef, Program, SetExpr, VarDefinition,
} from '../../src/verse/frontend/ast';

function parse(source: string): Program {
	return parseVerse(source);
}

function first(source: string): Expr {
	return parse(source).body[0];
}

describe('parser: definitions', () => {
	it('parses inferred definitions', () => {
		const d = first('X := 42') as Definition;
		expect(d.kind).toBe('Definition');
		expect(d.name).toBe('X');
		expect(d.value).toMatchObject({ kind: 'IntLit', value: 42 });
	});

	it('parses typed definitions', () => {
		const d = first('X : int = 42') as Definition;
		expect(d.kind).toBe('Definition');
		expect(d.type).toMatchObject({ kind: 'Ident', name: 'int' });
	});

	it('parses var declarations', () => {
		const d = first('var Count : int = 0') as VarDefinition;
		expect(d.kind).toBe('VarDefinition');
		expect(d.name).toBe('Count');
	});

	it('parses set expressions with compound operators', () => {
		const s = first('set X += 2') as SetExpr;
		expect(s.kind).toBe('SetExpr');
		expect(s.op).toBe('+=');
	});

	it('parses function definitions with effects', () => {
		const f = first('Add(A : int, B : int)<computes> : int = A + B') as FunctionDef;
		expect(f.kind).toBe('FunctionDef');
		expect(f.params.length).toBe(2);
		expect(f.effects.map((e) => e.name)).toEqual(['computes']);
		expect(f.returnType).toMatchObject({ kind: 'Ident', name: 'int' });
	});

	it('parses multi-line function bodies', () => {
		const f = first('F() : void =\n    X := 1\n    Y := 2\n') as FunctionDef;
		expect(f.kind).toBe('FunctionDef');
		expect(f.body?.kind).toBe('Block');
	});

	it('parses decides/suspends specifiers', () => {
		const f = first('Check(X : int)<decides><suspends> : void = X') as FunctionDef;
		expect(f.effects.map((e) => e.name)).toEqual(['decides', 'suspends']);
	});

	it('parses named and default parameters', () => {
		const f = first('F(X : int, ?Y : int = 5) : int = X + Y') as FunctionDef;
		expect(f.params[1].named).toBe(true);
		expect(f.params[1].defaultValue).toMatchObject({ kind: 'IntLit', value: 5 });
	});

	it('parses where clauses (parametric functions)', () => {
		const f = first('Identity(X : t where t : type) : t = X') as FunctionDef;
		expect(f.where.length).toBe(1);
		expect(f.where[0].name).toBe('t');
	});

	it('parses abstract declarations without bodies', () => {
		const f = first('GetSize() : int') as FunctionDef;
		expect(f.kind).toBe('FunctionDef');
		expect(f.body).toBeNull();
	});

	it('parses attributes', () => {
		const d = first('@editable\nSpeed : float = 1.0') as Definition;
		expect(d.attributes.map((a) => a.name)).toEqual(['editable']);
	});
});

describe('parser: classes and modules', () => {
	it('parses classes with members', () => {
		const source = [
			'my_class := class:',
			'    Name : string = "x"',
			'    var Count : int = 0',
			'    Get() : int = Count',
			'',
		].join('\n');
		const c = first(source) as ClassDef;
		expect(c.kind).toBe('ClassDef');
		expect(c.classKind).toBe('class');
		expect(c.members.length).toBe(3);
	});

	it('parses inheritance and specifiers', () => {
		const c = first('child := class<abstract>(parent, iface):\n    X : int = 1\n') as ClassDef;
		expect(c.specifiers.map((s) => s.name)).toContain('abstract');
		expect(c.supers.length).toBe(2);
	});

	it('parses structs and interfaces', () => {
		expect((first('point := struct:\n    X : int = 0\n') as ClassDef).classKind).toBe('struct');
		expect((first('shape := interface:\n    Area() : float\n') as ClassDef).classKind).toBe('interface');
	});

	it('parses parametric classes', () => {
		const c = first('box(t : type) := class:\n    Value : t\n') as ClassDef;
		expect(c.typeParams.length).toBe(1);
		expect(c.typeParams[0].name).toBe('t');
	});

	it('parses modules', () => {
		const m = first('utils := module:\n    Helper() : int = 1\n') as ModuleDef;
		expect(m.kind).toBe('ModuleDef');
		expect(m.members.length).toBe(1);
	});

	it('parses enums', () => {
		const e = first('color := enum{Red, Green, Blue}') as EnumDef;
		expect(e.values.map((v) => v.name)).toEqual(['Red', 'Green', 'Blue']);
	});

	it('parses using declarations', () => {
		const u = first('using { /Verse.org/Simulation }');
		expect(u).toMatchObject({ kind: 'UsingDecl', path: '/Verse.org/Simulation' });
	});

	it('parses block clauses inside classes', () => {
		const c = first('c := class:\n    var X : int = 0\n    block:\n        set X = 1\n') as ClassDef;
		expect(c.blocks.length).toBe(1);
		expect(c.members.length).toBe(1);
	});
});

describe('parser: control flow', () => {
	it('parses if with bindings, else-if chains, and else', () => {
		const source = [
			'if (X := F(), X > 2):',
			'    A()',
			'else if (Y < 1):',
			'    B()',
			'else:',
			'    C()',
			'',
		].join('\n');
		const node = first(source) as IfExpr;
		expect(node.kind).toBe('IfExpr');
		expect(node.clauses.length).toBe(2);
		expect(node.clauses[0].conditions[0].kind).toBe('Assignment');
		expect(node.elseBody).not.toBeNull();
	});

	it('parses if-then-else expressions', () => {
		const d = first('X := if (C?) then 1 else 2') as Definition;
		expect(d.value?.kind).toBe('IfExpr');
	});

	it('parses for with ranges, filters, and map iteration', () => {
		const f1 = first('for (I := 0..5):\n    P(I)\n') as ForExpr;
		expect(f1.generators.length).toBe(1);
		expect(f1.generators[0].iterable.kind).toBe('RangeExpr');

		const f2 = first('for (X : Items, X > 2):\n    P(X)\n') as ForExpr;
		expect(f2.generators.length).toBe(1);
		expect(f2.filters.length).toBe(1);

		const f3 = first('for (K -> V : M):\n    P(K, V)\n') as ForExpr;
		expect(f3.generators[0].valueName).toBe('V');
	});

	it('parses loop and break', () => {
		const node = first('loop:\n    break\n');
		expect(node.kind).toBe('LoopExpr');
	});

	it('parses case expressions', () => {
		const source = [
			'case (X):',
			'    1 => A()',
			'    2 => B()',
			'    _ => C()',
			'',
		].join('\n');
		const node = first(source);
		expect(node.kind).toBe('CaseExpr');
		if (node.kind === 'CaseExpr') {
			expect(node.arms.length).toBe(3);
			expect(node.arms[2].pattern).toBeNull();
		}
	});

	it('parses defer', () => {
		const node = first('defer:\n    Cleanup()\n');
		expect(node.kind).toBe('DeferExpr');
	});
});

describe('parser: concurrency', () => {
	it('parses spawn', () => {
		expect(first('spawn:\n    F()\n').kind).toBe('SpawnExpr');
		expect(first('spawn{F()}').kind).toBe('SpawnExpr');
	});

	it('parses race/sync/rush with clauses', () => {
		const node = first('race:\n    A()\n    B()\n');
		expect(node).toMatchObject({ kind: 'ConcurrencyBlock', op: 'race' });
		if (node.kind === 'ConcurrencyBlock') {
			expect(node.clauses.length).toBe(2);
		}
	});

	it('parses branch', () => {
		const node = first('branch:\n    A()\n');
		expect(node).toMatchObject({ kind: 'ConcurrencyBlock', op: 'branch' });
	});
});

describe('parser: expressions', () => {
	it('applies operator precedence', () => {
		const d = first('X := 1 + 2 * 3') as Definition;
		expect(d.value).toMatchObject({
			kind: 'Binary', op: '+',
			right: { kind: 'Binary', op: '*' },
		});
	});

	it('parses comparisons, and/or/not', () => {
		const d = first('R := not A and B or C') as Definition;
		expect(d.value?.kind).toBe('OrExpr');
	});

	it('parses failable calls and indexing with brackets', () => {
		const d = first('V := MyArray[3]') as Definition;
		expect(d.value).toMatchObject({ kind: 'Call', failable: true });
	});

	it('parses member access and calls', () => {
		const d = first('R := Foo.Bar(1).Baz') as Definition;
		expect(d.value?.kind).toBe('Member');
	});

	it('parses option query postfix', () => {
		const d = first('R := MaybeX?') as Definition;
		expect(d.value?.kind).toBe('QueryExpr');
	});

	it('parses container literals', () => {
		expect((first('A := array{1, 2, 3}') as Definition).value?.kind).toBe('ArrayLit');
		expect((first('M := map{1 => "a"}') as Definition).value?.kind).toBe('MapLit');
		expect((first('O := option{42}') as Definition).value?.kind).toBe('OptionLit');
		expect((first('T := (1, 2.0, "x")') as Definition).value?.kind).toBe('Tuple');
	});

	it('parses archetype instantiation', () => {
		const d = first('P := my_class{X := 1, Y := 2}') as Definition;
		expect(d.value?.kind).toBe('Archetype');
		if (d.value?.kind === 'Archetype') {
			expect(d.value.fields.map((f) => f.name)).toEqual(['X', 'Y']);
		}
	});

	it('parses string interpolation into expressions', () => {
		const d = first('S := "value: {X + 1}"') as Definition;
		expect(d.value?.kind).toBe('StringLit');
		if (d.value?.kind === 'StringLit') {
			expect(typeof d.value.parts[0]).toBe('string');
			expect((d.value.parts[1] as Expr).kind).toBe('Binary');
		}
	});

	it('parses type expressions', () => {
		const d = first('X : ?int = false') as Definition;
		expect(d.type?.kind).toBe('OptionType');
		const a = first('A : []string = array{}') as Definition;
		expect(a.type?.kind).toBe('ArrayType');
		const m = first('M : [string]int = map{}') as Definition;
		expect(m.type?.kind).toBe('MapType');
		const t = first('T : tuple(int, float) = (1, 2.0)') as Definition;
		expect(t.type?.kind).toBe('TupleType');
		const g = first('W : weak_map(player, int) = map{}') as Definition;
		expect(g.type?.kind).toBe('GenericType');
	});

	it('rejects reserved-future keywords as names', () => {
		expect(() => parse('await := 5')).toThrow(/reserved/);
	});
});

describe('parser: whole programs', () => {
	it('parses a realistic device program', () => {
		const source = [
			'using { /Verse.org/Simulation }',
			'',
			'hello_device := class(creative_device):',
			'',
			'    var Counter : int = 0',
			'',
			'    OnBegin<override>()<suspends> : void =',
			'        Print("Hello, world!")',
			'        for (Index := 1..3):',
			'            set Counter += Index',
			'            Print("Counter is now {Counter}")',
			'        if (Counter > 5):',
			'            Print("Done")',
			'',
		].join('\n');
		const program = parse(source);
		expect(program.body.length).toBe(2);
		const cls = program.body[1] as ClassDef;
		expect(cls.kind).toBe('ClassDef');
		const onBegin = cls.members[1] as FunctionDef;
		expect(onBegin.kind).toBe('FunctionDef');
		expect(onBegin.specifiers.map((s) => s.name)).toEqual(['override']);
		expect(onBegin.effects.map((s) => s.name)).toEqual(['suspends']);
	});
});
