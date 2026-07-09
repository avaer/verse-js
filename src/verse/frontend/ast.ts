// ast.ts
// AST for the Verse front end. One node family for expressions (Verse is
// expression-oriented: definitions, classes, and control flow are all
// expressions), plus small helper shapes for parameters, specifiers, and
// attributes.

import { Span } from './tokens';

export interface Specifier {
	name: string;
	/** Raw argument source for parameterized specifiers like scoped{...}. */
	arg?: string;
	span: Span;
}

export interface Attribute {
	name: string;
	/** Argument expressions, e.g. @doc("..."). */
	args: Expr[];
	span: Span;
}

export interface Param {
	name: string;
	/** True for ?Named := default parameters. */
	named: boolean;
	type: Expr | null;
	defaultValue: Expr | null;
	span: Span;
}

export interface WhereClause {
	/** Type parameter name, e.g. `t`. */
	name: string;
	/** Constraint expression, e.g. `type` or `subtype(comparable)`. */
	constraint: Expr | null;
	span: Span;
}

export interface CaseArm {
	/** null for the wildcard `_`. */
	pattern: Expr | null;
	body: Expr;
	span: Span;
}

export interface ForGenerator {
	/** Loop variable, or key variable for `K -> V : M`. */
	name: string;
	/** Value variable for map iteration (`K -> V : M`), else null. */
	valueName: string | null;
	iterable: Expr;
	span: Span;
}

export type Expr =
	| IntLit | FloatLit | CharLit | StringLit | LogicLit
	| Ident | SelfExpr | Placeholder
	| Block | Tuple | ArrayLit | MapLit | OptionLit | RangeExpr | TypeLit
	| Unary | Binary | AndExpr | OrExpr | NotExpr | QueryExpr
	| Call | Index | Member | Archetype
	| Definition | VarDefinition | SetExpr | Assignment
	| FunctionDef | ClassDef | ModuleDef | EnumDef | TypeAliasDef
	| UsingDecl
	| IfExpr | CaseExpr | ForExpr | LoopExpr | WhileExpr | BreakExpr
	| ReturnExpr | DeferExpr
	| SpawnExpr | ConcurrencyBlock
	| OptionType | ArrayType | MapType | TupleType | FunctionType | GenericType
	| Interpolant | FailureExpr | ProfileExpr;

interface BaseNode {
	span: Span;
}

// --- literals & atoms ---

export interface IntLit extends BaseNode { kind: 'IntLit'; value: number }
export interface FloatLit extends BaseNode { kind: 'FloatLit'; value: number }
export interface CharLit extends BaseNode { kind: 'CharLit'; value: string }
export interface LogicLit extends BaseNode { kind: 'LogicLit'; value: boolean }

export interface StringLit extends BaseNode {
	kind: 'StringLit';
	/** Alternating literal text and interpolated expressions, in order. */
	parts: (string | Expr)[];
}

export interface Ident extends BaseNode { kind: 'Ident'; name: string }
export interface SelfExpr extends BaseNode { kind: 'SelfExpr' }
/** `_` in expression/pattern position. */
export interface Placeholder extends BaseNode { kind: 'Placeholder' }

/** Interpolated segment marker used only inside StringLit during checking. */
export interface Interpolant extends BaseNode { kind: 'Interpolant'; expr: Expr }

// --- composite literals ---

export interface Block extends BaseNode { kind: 'Block'; exprs: Expr[]; label: 'block' | 'braces' }
export interface Tuple extends BaseNode { kind: 'Tuple'; elements: Expr[] }
export interface ArrayLit extends BaseNode { kind: 'ArrayLit'; elements: Expr[] }
export interface MapLit extends BaseNode { kind: 'MapLit'; entries: { key: Expr; value: Expr }[] }
export interface OptionLit extends BaseNode { kind: 'OptionLit'; value: Expr | null }
export interface RangeExpr extends BaseNode { kind: 'RangeExpr'; low: Expr; high: Expr }
/** `type{...}` opaque type expression. */
export interface TypeLit extends BaseNode { kind: 'TypeLit'; raw: string }

// --- operators ---

export interface Unary extends BaseNode { kind: 'Unary'; op: '-' | '+'; operand: Expr }

export interface Binary extends BaseNode {
	kind: 'Binary';
	op: '+' | '-' | '*' | '/' | '=' | '<>' | '<' | '<=' | '>' | '>=';
	left: Expr;
	right: Expr;
}

export interface AndExpr extends BaseNode { kind: 'AndExpr'; left: Expr; right: Expr }
export interface OrExpr extends BaseNode { kind: 'OrExpr'; left: Expr; right: Expr }
export interface NotExpr extends BaseNode { kind: 'NotExpr'; operand: Expr }
/** Postfix `?`: unwrap option / test logic (failable). */
export interface QueryExpr extends BaseNode { kind: 'QueryExpr'; operand: Expr }

// --- postfix ---

export interface CallArg {
	/** Present for named arguments `?Name := Value`. */
	name: string | null;
	value: Expr;
}

export interface Call extends BaseNode {
	kind: 'Call';
	callee: Expr;
	args: CallArg[];
	/** True for failable call syntax `F[...]`. */
	failable: boolean;
}

export interface Index extends BaseNode { kind: 'Index'; target: Expr; index: Expr }
export interface Member extends BaseNode { kind: 'Member'; target: Expr; name: string; superCall?: boolean }

export interface Archetype extends BaseNode {
	kind: 'Archetype';
	callee: Expr;
	fields: { name: string; value: Expr; span: Span }[];
	/** Positional body expressions for forms like logic{X}. */
	body: Expr[];
}

// --- definitions ---

export interface Definition extends BaseNode {
	kind: 'Definition';
	name: string;
	specifiers: Specifier[];
	attributes: Attribute[];
	type: Expr | null;
	value: Expr | null;
}

export interface VarDefinition extends BaseNode {
	kind: 'VarDefinition';
	name: string;
	specifiers: Specifier[];
	attributes: Attribute[];
	type: Expr | null;
	value: Expr | null;
}

export interface SetExpr extends BaseNode {
	kind: 'SetExpr';
	target: Expr;
	op: '=' | '+=' | '-=' | '*=' | '/=';
	value: Expr;
}

/** Bare `X := Y` in expression position (e.g. inside if conditions). */
export interface Assignment extends BaseNode {
	kind: 'Assignment';
	name: string;
	type: Expr | null;
	value: Expr;
}

export interface FunctionDef extends BaseNode {
	kind: 'FunctionDef';
	name: string;
	specifiers: Specifier[];
	effects: Specifier[];
	attributes: Attribute[];
	params: Param[];
	where: WhereClause[];
	/** null for `<constructor>`-style definitions (`F(...) := ...`). */
	returnType: Expr | null;
	body: Expr | null;
	/** For `(X : T).Name(...)` extension methods: T (the target type). */
	extensionTarget: Expr | null;
	/** The receiver name X in `(X : T).Name(...)`. */
	extensionSelfName?: string;
}

export interface ClassMemberBlock extends BaseNode { kind: 'MemberBlock'; body: Expr }

export interface ClassDef extends BaseNode {
	kind: 'ClassDef';
	name: string;
	classKind: 'class' | 'struct' | 'interface';
	specifiers: Specifier[];
	attributes: Attribute[];
	/** Type parameters for parametric classes: c(t : type) := class ... */
	typeParams: Param[];
	supers: Expr[];
	members: Expr[];
	blocks: Expr[];
}

export interface ModuleDef extends BaseNode {
	kind: 'ModuleDef';
	name: string;
	specifiers: Specifier[];
	attributes: Attribute[];
	members: Expr[];
}

export interface EnumDef extends BaseNode {
	kind: 'EnumDef';
	name: string;
	specifiers: Specifier[];
	attributes: Attribute[];
	values: { name: string; span: Span }[];
}

export interface TypeAliasDef extends BaseNode {
	kind: 'TypeAliasDef';
	name: string;
	value: Expr;
}

export interface UsingDecl extends BaseNode {
	kind: 'UsingDecl';
	/** Module path, e.g. "/Verse.org/Simulation", or a local module name. */
	path: string;
}

// --- control flow ---

export interface IfClause {
	/** Conditions (bindings and failable exprs); empty for `else`. */
	conditions: Expr[];
	body: Expr;
	span: Span;
}

export interface IfExpr extends BaseNode {
	kind: 'IfExpr';
	clauses: IfClause[];
	elseBody: Expr | null;
}

export interface CaseExpr extends BaseNode {
	kind: 'CaseExpr';
	subject: Expr;
	arms: CaseArm[];
}

export interface ForExpr extends BaseNode {
	kind: 'ForExpr';
	generators: ForGenerator[];
	/** Failable filter expressions between generators. */
	filters: Expr[];
	body: Expr;
}

export interface LoopExpr extends BaseNode { kind: 'LoopExpr'; body: Expr }
export interface WhileExpr extends BaseNode { kind: 'WhileExpr'; condition: Expr; body: Expr }
export interface BreakExpr extends BaseNode { kind: 'BreakExpr' }
export interface ReturnExpr extends BaseNode { kind: 'ReturnExpr'; value: Expr | null }
export interface DeferExpr extends BaseNode { kind: 'DeferExpr'; body: Expr }
/** Reserved-word expression we parse but reject in sema (await, upon, ...). */
export interface FailureExpr extends BaseNode { kind: 'FailureExpr'; keyword: string }
export interface ProfileExpr extends BaseNode { kind: 'ProfileExpr'; label: Expr | null; body: Expr }

// --- concurrency ---

export interface SpawnExpr extends BaseNode { kind: 'SpawnExpr'; body: Expr }

export interface ConcurrencyBlock extends BaseNode {
	kind: 'ConcurrencyBlock';
	op: 'race' | 'sync' | 'rush' | 'branch';
	clauses: Expr[];
}

// --- type expressions ---

export interface OptionType extends BaseNode { kind: 'OptionType'; inner: Expr }
export interface ArrayType extends BaseNode { kind: 'ArrayType'; element: Expr }
export interface MapType extends BaseNode { kind: 'MapType'; key: Expr; value: Expr }
export interface TupleType extends BaseNode { kind: 'TupleType'; elements: Expr[] }
export interface FunctionType extends BaseNode {
	kind: 'FunctionType';
	params: Expr[];
	result: Expr;
	effects: Specifier[];
}
/** Named type application: container(int), weak_map(player, int), etc. */
export interface GenericType extends BaseNode { kind: 'GenericType'; base: Expr; args: Expr[] }

// --- program ---

export interface Program {
	kind: 'Program';
	body: Expr[];
	span: Span;
}

export function isDefinitionNode(e: Expr): boolean {
	switch (e.kind) {
		case 'Definition':
		case 'VarDefinition':
		case 'FunctionDef':
		case 'ClassDef':
		case 'ModuleDef':
		case 'EnumDef':
		case 'TypeAliasDef':
			return true;
		default:
			return false;
	}
}
