// types.ts
// The Verse type lattice: primitives, containers, nominal classes/interfaces/
// enums, tuples, functions, type parameters. Provides subtyping, joins,
// generic substitution/unification, and printing.

import { Span } from '../frontend/tokens';
import { EffectSet, makeEffects } from './effects';

export type VType =
	| PrimType
	| OptionT | ArrayT | MapT | TupleT | FuncT
	| ClassT | EnumT | TypeParamT | TypeValueT | UnionT;

export interface PrimType {
	k: 'int' | 'float' | 'rational' | 'logic' | 'char' | 'char32' | 'string'
	| 'void' | 'any' | 'comparable' | 'type' | 'never' | 'unknown';
}

export interface OptionT { k: 'option'; inner: VType }
export interface ArrayT { k: 'array'; element: VType }
export interface MapT { k: 'map'; key: VType; value: VType; weak: boolean }
export interface TupleT { k: 'tuple'; elements: VType[] }

export interface FuncParam {
	name: string;
	type: VType;
	named: boolean;
	hasDefault: boolean;
}

export interface FuncT {
	k: 'func';
	params: FuncParam[];
	ret: VType;
	effects: EffectSet;
	/** Type parameters from a `where` clause, if any. */
	typeParams: TypeParamT[];
}

export interface MemberInfo {
	name: string;
	type: VType;
	mutable: boolean;
	access: 'public' | 'private' | 'protected' | 'internal';
	isMethod: boolean;
	hasBody: boolean;
	/** Overload set for functions with multiple definitions. */
	overloads?: FuncT[];
	origin: ClassInfo;
	/** Declaration site (for go-to-definition); null for natives. */
	declSpan?: Span | null;
	/** Workspace file of the declaration (multi-file compiles). */
	declFile?: string | null;
}

export interface ClassInfo {
	name: string;
	kind: 'class' | 'struct' | 'interface';
	supers: ClassInfo[];
	members: Map<string, MemberInfo>;
	typeParams: TypeParamT[];
	abstract: boolean;
	final: boolean;
	unique: boolean;
	castable: boolean;
	concrete: boolean;
	persistable: boolean;
	/** True for engine-provided classes (creative_device, ...). */
	native: boolean;
	modulePath: string | null;
}

export interface EnumInfo {
	name: string;
	values: string[];
	open: boolean;
	modulePath: string | null;
}

export interface ClassT { k: 'class'; info: ClassInfo; typeArgs: VType[] }
export interface EnumT { k: 'enum'; info: EnumInfo }
export interface TypeParamT { k: 'typeParam'; name: string; constraint: VType | null; id: number }
/** A type used as a value (cast targets, `type` parameters). */
export interface TypeValueT { k: 'typeValue'; of: VType }
export interface UnionT { k: 'union'; members: VType[] }

let nextTypeParamId = 1;

export const T = {
	int: { k: 'int' } as VType,
	float: { k: 'float' } as VType,
	rational: { k: 'rational' } as VType,
	logic: { k: 'logic' } as VType,
	char: { k: 'char' } as VType,
	char32: { k: 'char32' } as VType,
	string: { k: 'string' } as VType,
	void: { k: 'void' } as VType,
	any: { k: 'any' } as VType,
	comparable: { k: 'comparable' } as VType,
	type: { k: 'type' } as VType,
	never: { k: 'never' } as VType,
	unknown: { k: 'unknown' } as VType,
	option(inner: VType): VType { return { k: 'option', inner }; },
	array(element: VType): VType { return { k: 'array', element }; },
	map(key: VType, value: VType, weak = false): VType { return { k: 'map', key, value, weak }; },
	tuple(elements: VType[]): VType { return { k: 'tuple', elements }; },
	func(params: VType[], ret: VType, effects: Partial<EffectSet> = {}): FuncT {
		return {
			k: 'func',
			params: params.map((type, i) => ({ name: `$${i}`, type, named: false, hasDefault: false })),
			ret,
			effects: makeEffects(effects),
			typeParams: [],
		};
	},
	classType(info: ClassInfo, typeArgs: VType[] = []): ClassT {
		return { k: 'class', info, typeArgs };
	},
	enumType(info: EnumInfo): EnumT { return { k: 'enum', info }; },
	typeParam(name: string, constraint: VType | null = null): TypeParamT {
		return { k: 'typeParam', name, constraint, id: nextTypeParamId++ };
	},
	typeValue(of: VType): VType { return { k: 'typeValue', of }; },
	union(members: VType[]): VType {
		if (members.length === 1) {
			return members[0];
		}
		return { k: 'union', members };
	},
};

export function makeClassInfo(name: string, kind: ClassInfo['kind']): ClassInfo {
	return {
		name,
		kind,
		supers: [],
		members: new Map(),
		typeParams: [],
		abstract: false,
		final: false,
		unique: false,
		castable: false,
		concrete: false,
		persistable: false,
		native: false,
		modulePath: null,
	};
}

// --- subtyping ---

export function isSubtype(a: VType, b: VType): boolean {
	if (a === b) {
		return true;
	}
	if (a.k === 'never' || a.k === 'unknown' || b.k === 'unknown' || b.k === 'any') {
		return true;
	}
	if (a.k === 'any') {
		return false;
	}
	if (b.k === 'comparable') {
		return isComparable(a);
	}
	if (a.k === 'union') {
		return a.members.every((m) => isSubtype(m, b));
	}
	if (b.k === 'union') {
		return b.members.some((m) => isSubtype(a, m));
	}
	if (b.k === 'typeParam') {
		// Occurs during generic checking before substitution; accept when the
		// constraint accepts it (or no constraint).
		return b.constraint === null || isSubtype(a, b.constraint);
	}
	if (a.k === 'typeParam') {
		return a.constraint !== null && isSubtype(a.constraint, b);
	}

	switch (b.k) {
		case 'int': return a.k === 'int';
		case 'rational': return a.k === 'rational' || a.k === 'int';
		case 'float': return a.k === 'float';
		case 'logic': return a.k === 'logic';
		case 'char': return a.k === 'char';
		case 'char32': return a.k === 'char32' || a.k === 'char';
		case 'string': return a.k === 'string';
		case 'void': return true; // everything coerces to void
		case 'type': return a.k === 'type' || a.k === 'typeValue';
		case 'option':
			return a.k === 'option' && isSubtype(a.inner, b.inner);
		case 'array':
			if (a.k === 'string') {
				return isSubtype(T.char, b.element); // string = []char
			}
			return a.k === 'array' && isSubtype(a.element, b.element);
		case 'map': {
			if (a.k !== 'map') {
				return false;
			}
			// weak_map is a supertype of map; maps are covariant in both.
			if (a.weak && !b.weak) {
				return false;
			}
			return isSubtype(a.key, b.key) && isSubtype(a.value, b.value);
		}
		case 'tuple':
			return a.k === 'tuple' && a.elements.length === b.elements.length &&
				a.elements.every((e, i) => isSubtype(e, b.elements[i]));
		case 'func': {
			if (a.k !== 'func') {
				return false;
			}
			if (a.params.length !== b.params.length) {
				return false;
			}
			// Contravariant params, covariant result.
			return b.params.every((p, i) => isSubtype(p.type, a.params[i].type)) &&
				isSubtype(a.ret, b.ret);
		}
		case 'class': {
			if (a.k === 'class') {
				return classConforms(a.info, b.info) && typeArgsCompatible(a, b);
			}
			return false;
		}
		case 'enum':
			return a.k === 'enum' && a.info === b.info;
		case 'typeValue':
			return a.k === 'typeValue';
		case 'never':
			return false; // (a.k === 'never' already returned true above)
		default:
			return false;
	}
}

function classConforms(sub: ClassInfo, sup: ClassInfo): boolean {
	if (sub === sup) {
		return true;
	}
	for (const parent of sub.supers) {
		if (classConforms(parent, sup)) {
			return true;
		}
	}
	return false;
}

function typeArgsCompatible(a: ClassT, b: ClassT): boolean {
	if (b.typeArgs.length === 0) {
		return true;
	}
	if (a.info === b.info && a.typeArgs.length === b.typeArgs.length) {
		// Covariant check; Verse computes variance from member polarity, we
		// approximate with covariance (safe for the common container cases).
		return a.typeArgs.every((arg, i) => isSubtype(arg, b.typeArgs[i]));
	}
	return true;
}

export function isComparable(t: VType): boolean {
	switch (t.k) {
		case 'int': case 'float': case 'rational': case 'logic': case 'char':
		case 'char32': case 'string': case 'comparable': case 'enum':
		case 'unknown': case 'never': case 'typeParam':
			return true;
		case 'option': return isComparable(t.inner);
		case 'array': return isComparable(t.element);
		case 'map': return !t.weak && isComparable(t.key) && isComparable(t.value);
		case 'tuple': return t.elements.every(isComparable);
		case 'class': return t.info.unique || (t.info.kind === 'struct' && [...t.info.members.values()].every((m) => isComparable(m.type)));
		default: return false;
	}
}

/** Least upper bound (approximate; used for if/case result types). */
export function joinTypes(a: VType, b: VType): VType {
	if (isSubtype(a, b)) {
		return b;
	}
	if (isSubtype(b, a)) {
		return a;
	}
	if (a.k === 'int' && b.k === 'rational') {
		return b;
	}
	if (a.k === 'rational' && b.k === 'int') {
		return a;
	}
	if (a.k === 'class' && b.k === 'class') {
		for (const candidate of allSupers(a.info)) {
			if (classConforms(b.info, candidate)) {
				return T.classType(candidate);
			}
		}
	}
	return T.any;
}

function allSupers(info: ClassInfo): ClassInfo[] {
	const result: ClassInfo[] = [info];
	for (const parent of info.supers) {
		result.push(...allSupers(parent));
	}
	return result;
}

// --- generic substitution & unification ---

export type Substitution = Map<number, VType>;

export function substitute(t: VType, sub: Substitution): VType {
	switch (t.k) {
		case 'typeParam':
			return sub.get(t.id) ?? t;
		case 'option':
			return T.option(substitute(t.inner, sub));
		case 'array':
			return T.array(substitute(t.element, sub));
		case 'map':
			return T.map(substitute(t.key, sub), substitute(t.value, sub), t.weak);
		case 'tuple':
			return T.tuple(t.elements.map((e) => substitute(e, sub)));
		case 'func':
			return {
				k: 'func',
				params: t.params.map((p) => ({ ...p, type: substitute(p.type, sub) })),
				ret: substitute(t.ret, sub),
				effects: t.effects,
				typeParams: t.typeParams,
			};
		case 'class':
			if (t.typeArgs.length === 0) {
				return t;
			}
			return T.classType(t.info, t.typeArgs.map((a) => substitute(a, sub)));
		case 'typeValue':
			return T.typeValue(substitute(t.of, sub));
		case 'union':
			return T.union(t.members.map((m) => substitute(m, sub)));
		default:
			return t;
	}
}

/**
 * Unifies `pattern` (may contain type params) against `actual`, extending
 * `sub`. Returns false when they cannot match.
 */
export function unify(pattern: VType, actual: VType, sub: Substitution): boolean {
	if (pattern.k === 'typeParam') {
		const bound = sub.get(pattern.id);
		if (bound) {
			// Widen the binding when needed rather than failing.
			sub.set(pattern.id, joinTypes(bound, actual));
			return true;
		}
		if (pattern.constraint && !isSubtype(actual, pattern.constraint)) {
			return false;
		}
		sub.set(pattern.id, actual);
		return true;
	}
	if (actual.k === 'unknown' || actual.k === 'never' || pattern.k === 'unknown' || pattern.k === 'any') {
		return true;
	}
	switch (pattern.k) {
		case 'option':
			return actual.k === 'option' && unify(pattern.inner, actual.inner, sub);
		case 'array':
			if (actual.k === 'string') {
				return unify(pattern.element, T.char, sub);
			}
			return actual.k === 'array' && unify(pattern.element, actual.element, sub);
		case 'map':
			return actual.k === 'map' && unify(pattern.key, actual.key, sub) && unify(pattern.value, actual.value, sub);
		case 'tuple':
			return actual.k === 'tuple' && actual.elements.length === pattern.elements.length &&
				pattern.elements.every((e, i) => unify(e, actual.elements[i], sub));
		case 'func':
			return actual.k === 'func' && actual.params.length === pattern.params.length &&
				pattern.params.every((p, i) => unify(p.type, actual.params[i].type, sub)) &&
				unify(pattern.ret, actual.ret, sub);
		case 'typeValue':
			return actual.k === 'typeValue' && unify(pattern.of, actual.of, sub);
		case 'class':
			if (actual.k !== 'class') {
				return isSubtype(actual, pattern);
			}
			if (pattern.typeArgs.length > 0 && actual.info === pattern.info) {
				return pattern.typeArgs.every((arg, i) => unify(arg, actual.typeArgs[i] ?? T.unknown, sub));
			}
			return isSubtype(actual, pattern);
		default:
			return isSubtype(actual, pattern);
	}
}

// --- printing ---

export function typeToString(t: VType): string {
	switch (t.k) {
		case 'option': return `?${typeToString(t.inner)}`;
		case 'array': return `[]${typeToString(t.element)}`;
		case 'map': return `${t.weak ? 'weak_map(' : '['}${typeToString(t.key)}${t.weak ? ', ' : ']'}${typeToString(t.value)}${t.weak ? ')' : ''}`;
		case 'tuple': return `tuple(${t.elements.map(typeToString).join(', ')})`;
		case 'func': {
			const params = t.params.map((p) => `${p.named ? '?' : ''}${typeToString(p.type)}`).join(', ');
			return `(${params}) -> ${typeToString(t.ret)}`;
		}
		case 'class': {
			if (t.typeArgs.length > 0) {
				return `${t.info.name}(${t.typeArgs.map(typeToString).join(', ')})`;
			}
			return t.info.name;
		}
		case 'enum': return t.info.name;
		case 'typeParam': return t.name;
		case 'typeValue': return `type(${typeToString(t.of)})`;
		case 'union': return t.members.map(typeToString).join(' | ');
		default: return t.k;
	}
}
