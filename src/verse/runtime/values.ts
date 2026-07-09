// values.ts
// Runtime value model for Verse.
//
//   int/float      -> JS number (ints are checked; see docs for deviations)
//   rational       -> VRational (exact numerator/denominator)
//   logic          -> JS boolean
//   char/char32    -> single-character JS string
//   string         -> JS string
//   array          -> JS array (aliased; elements journaled by transactions)
//   map/weak_map   -> VMap (insertion-ordered, comparable keys)
//   tuple          -> VTuple
//   option         -> VOption (EMPTY_OPTION singleton for `false`)
//   class instance -> VObject; struct value -> VStruct (copy semantics)
//   enum value     -> VEnumValue
//   function       -> VFunctionValue (user) / VNativeFunction (builtin)
//   type value     -> VTypeValue (cast target)
//   void           -> undefined

import type { VType } from '../sema/types';

export type Value =
	| number | boolean | string | undefined
	| VRational | VOption | VTuple | VMap | VObject | VEnumValue
	| VFunctionValue | VNativeFunction | VTypeValue | Value[]
	| VTask | VEventValue;

/** Sentinel returned by failable evaluation when it fails. */
export const FAIL: unique symbol = Symbol('VerseFail');
export type Failable<T> = T | typeof FAIL;

function gcd(a: number, b: number): number {
	a = Math.abs(a);
	b = Math.abs(b);
	while (b !== 0) {
		const t = a % b;
		a = b;
		b = t;
	}
	return a === 0 ? 1 : a;
}

export class VRational {
	num: number;
	den: number;

	constructor(num: number, den: number) {
		if (den < 0) {
			num = -num;
			den = -den;
		}
		const g = gcd(num, den);
		this.num = num / g;
		this.den = den / g;
	}

	static fromInt(value: number): VRational {
		return new VRational(value, 1);
	}

	toFloat(): number {
		return this.num / this.den;
	}

	floor(): number {
		return Math.floor(this.num / this.den);
	}

	ceil(): number {
		return Math.ceil(this.num / this.den);
	}

	add(other: VRational): VRational {
		return new VRational(this.num * other.den + other.num * this.den, this.den * other.den);
	}

	sub(other: VRational): VRational {
		return new VRational(this.num * other.den - other.num * this.den, this.den * other.den);
	}

	mul(other: VRational): VRational {
		return new VRational(this.num * other.num, this.den * other.den);
	}

	div(other: VRational): VRational | typeof FAIL {
		if (other.num === 0) {
			return FAIL;
		}
		return new VRational(this.num * other.den, this.den * other.num);
	}

	compare(other: VRational): number {
		return this.num * other.den - other.num * this.den;
	}
}

export function asRational(v: Value): VRational {
	if (v instanceof VRational) {
		return v;
	}
	return VRational.fromInt(v as number);
}

export class VOption {
	/** undefined encodes the empty option (`false`). */
	value: Value | undefined;

	private constructor(value: Value | undefined) {
		this.value = value;
	}

	static some(value: Value): VOption {
		return new VOption(value);
	}

	static readonly EMPTY = new VOption(undefined);

	get isSet(): boolean {
		return this.value !== undefined || this.hasExplicitValue;
	}

	private hasExplicitValue = false;

	static someAllowingUndefined(value: Value): VOption {
		const opt = new VOption(value);
		opt.hasExplicitValue = true;
		return opt;
	}
}

export class VTuple {
	elements: Value[];

	constructor(elements: Value[]) {
		this.elements = elements;
	}
}

export class VMap {
	/** canonical key -> [original key, value]; insertion-ordered. */
	entries: Map<string, [Value, Value]>;
	weak: boolean;

	constructor(weak = false) {
		this.entries = new Map();
		this.weak = weak;
	}

	get(key: Value): Failable<Value> {
		const found = this.entries.get(canonicalKey(key));
		return found === undefined ? FAIL : found[1];
	}

	has(key: Value): boolean {
		return this.entries.has(canonicalKey(key));
	}

	set(key: Value, value: Value): void {
		this.entries.set(canonicalKey(key), [key, value]);
	}

	delete(key: Value): boolean {
		return this.entries.delete(canonicalKey(key));
	}

	get size(): number {
		return this.entries.size;
	}

	*pairs(): IterableIterator<[Value, Value]> {
		for (const [, pair] of this.entries) {
			yield pair;
		}
	}

	clone(): VMap {
		const copy = new VMap(this.weak);
		copy.entries = new Map(this.entries);
		return copy;
	}
}

let nextObjectId = 1;

export interface RuntimeClassLike {
	name: string;
	isStruct: boolean;
	conforms(name: string): boolean;
}

export class VObject {
	cls: RuntimeClassLike;
	fields: Map<string, Value>;
	readonly objectId: number;
	/** Stable identity for persistence (e.g. the session player). */
	persistKey?: string;

	constructor(cls: RuntimeClassLike, fields: Map<string, Value>) {
		this.cls = cls;
		this.fields = fields;
		this.objectId = nextObjectId++;
	}
}

export class VStruct extends VObject {
	copy(): VStruct {
		return new VStruct(this.cls, new Map(this.fields));
	}
}

export class VEnumValue {
	enumName: string;
	name: string;
	ordinal: number;

	constructor(enumName: string, name: string, ordinal: number) {
		this.enumName = enumName;
		this.name = name;
		this.ordinal = ordinal;
	}
}

/** A compiled user function bound to its captured environment. */
export class VFunctionValue {
	name: string;
	/** (self, args) -> Value | FAIL | Promise<Value | FAIL> */
	invoke: (self: Value, args: Value[]) => unknown;
	self: Value;

	constructor(name: string, invoke: (self: Value, args: Value[]) => unknown, self: Value = undefined) {
		this.name = name;
		this.invoke = invoke;
		this.self = self;
	}

	bind(self: Value): VFunctionValue {
		return new VFunctionValue(this.name, this.invoke, self);
	}
}

export class VNativeFunction {
	name: string;
	invoke: (args: Value[], ctx: unknown) => unknown;

	constructor(name: string, invoke: (args: Value[], ctx: unknown) => unknown) {
		this.name = name;
		this.invoke = invoke;
	}
}

export class VTypeValue {
	name: string;
	vtype: VType | null;
	/** Returns the value on success or FAIL (dynamic cast). */
	cast: (value: Value) => Failable<Value>;

	constructor(name: string, vtype: VType | null, cast: (value: Value) => Failable<Value>) {
		this.name = name;
		this.vtype = vtype;
		this.cast = cast;
	}
}

// Forward declarations for scheduler types (defined in scheduler.ts) to keep
// the Value union closed without circular imports.
export interface VTask {
	readonly isVerseTask: true;
	awaitResult(): Promise<Value>;
	cancel(): void;
	isComplete(): boolean;
}

export interface VEventValue {
	readonly isVerseEvent: true;
	signal(payload: Value): void;
	awaitSignal(): Promise<Value>;
}

export function isTask(v: Value): v is VTask {
	return typeof v === 'object' && v !== null && (v as VTask).isVerseTask === true;
}

export function isEvent(v: Value): v is VEventValue {
	return typeof v === 'object' && v !== null && (v as VEventValue).isVerseEvent === true;
}

// --- structural equality & canonical keys (comparable semantics) ---

export function verseEquals(a: Value, b: Value): boolean {
	if (a === b) {
		return true;
	}
	if (typeof a === 'number' && b instanceof VRational) {
		return b.den === 1 && b.num === a;
	}
	if (a instanceof VRational && typeof b === 'number') {
		return a.den === 1 && a.num === b;
	}
	if (a instanceof VRational && b instanceof VRational) {
		return a.num === b.num && a.den === b.den;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => verseEquals(v, b[i]));
	}
	if (a instanceof VTuple && b instanceof VTuple) {
		return a.elements.length === b.elements.length &&
			a.elements.every((v, i) => verseEquals(v, b.elements[i]));
	}
	if (a instanceof VOption && b instanceof VOption) {
		if (!a.isSet && !b.isSet) {
			return true;
		}
		if (a.isSet !== b.isSet) {
			return false;
		}
		return verseEquals(a.value, b.value);
	}
	if (a instanceof VMap && b instanceof VMap) {
		if (a.size !== b.size) {
			return false;
		}
		for (const [key, value] of a.pairs()) {
			const other = b.get(key);
			if (other === FAIL || !verseEquals(value, other)) {
				return false;
			}
		}
		return true;
	}
	if (a instanceof VEnumValue && b instanceof VEnumValue) {
		return a.enumName === b.enumName && a.name === b.name;
	}
	if (a instanceof VStruct && b instanceof VStruct) {
		if (a.cls !== b.cls) {
			return false;
		}
		for (const [name, value] of a.fields) {
			if (!verseEquals(value, b.fields.get(name))) {
				return false;
			}
		}
		return true;
	}
	// Class instances (including <unique>) compare by identity.
	return false;
}

export function canonicalKey(v: Value): string {
	if (v === undefined) {
		return 'void';
	}
	if (typeof v === 'number') {
		return Number.isInteger(v) ? `i${v}` : `f${v}`;
	}
	if (typeof v === 'boolean') {
		return `l${v}`;
	}
	if (typeof v === 'string') {
		return `s${JSON.stringify(v)}`;
	}
	if (v instanceof VRational) {
		return v.den === 1 ? `i${v.num}` : `r${v.num}/${v.den}`;
	}
	if (Array.isArray(v)) {
		return `a[${v.map(canonicalKey).join(',')}]`;
	}
	if (v instanceof VTuple) {
		return `t(${v.elements.map(canonicalKey).join(',')})`;
	}
	if (v instanceof VOption) {
		return v.isSet ? `o(${canonicalKey(v.value)})` : 'o()';
	}
	if (v instanceof VMap) {
		return `m{${[...v.pairs()].map(([k, val]) => `${canonicalKey(k)}:${canonicalKey(val)}`).join(',')}}`;
	}
	if (v instanceof VEnumValue) {
		return `e${v.enumName}.${v.name}`;
	}
	if (v instanceof VStruct) {
		return `st${v.cls.name}{${[...v.fields.entries()].map(([k, val]) => `${k}:${canonicalKey(val)}`).join(',')}}`;
	}
	if (v instanceof VObject) {
		return v.persistKey ?? `obj#${v.objectId}`;
	}
	return `x#${String(v)}`;
}

// --- printing ---

export function verseToString(v: Value): string {
	if (v === undefined) {
		return '';
	}
	if (typeof v === 'number') {
		if (Number.isInteger(v)) {
			return String(v);
		}
		return formatFloat(v);
	}
	if (typeof v === 'boolean') {
		return v ? 'true' : 'false';
	}
	if (typeof v === 'string') {
		return v;
	}
	if (v instanceof VRational) {
		return v.den === 1 ? String(v.num) : `${v.num}/${v.den}`;
	}
	return verseToDiagnostic(v);
}

/**
 * Float-specific formatting: integral floats keep a trailing ".0" like real
 * Verse. Callers must know statically that the value is a float, since the
 * runtime representation (JS number) can't distinguish 3.0 from 3.
 */
export function verseFloatToString(v: Value): string {
	return typeof v === 'number' ? formatFloat(v) : verseToString(v);
}

function formatFloat(v: number): string {
	if (Number.isNaN(v)) {
		return 'NaN';
	}
	if (!Number.isFinite(v)) {
		return v > 0 ? 'Inf' : '-Inf';
	}
	const s = String(v);
	return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

export function verseToDiagnostic(v: Value): string {
	if (v === undefined) {
		return 'void';
	}
	if (typeof v === 'string') {
		return JSON.stringify(v);
	}
	if (typeof v === 'number' && !Number.isInteger(v)) {
		return formatFloat(v);
	}
	if (typeof v === 'number' || typeof v === 'boolean') {
		return verseToString(v);
	}
	if (v instanceof VRational) {
		return verseToString(v);
	}
	if (Array.isArray(v)) {
		return `array{${v.map(verseToDiagnostic).join(', ')}}`;
	}
	if (v instanceof VTuple) {
		return `(${v.elements.map(verseToDiagnostic).join(', ')})`;
	}
	if (v instanceof VOption) {
		return v.isSet ? `option{${verseToDiagnostic(v.value)}}` : 'false';
	}
	if (v instanceof VMap) {
		return `map{${[...v.pairs()].map(([k, val]) => `${verseToDiagnostic(k)} => ${verseToDiagnostic(val)}`).join(', ')}}`;
	}
	if (v instanceof VEnumValue) {
		return `${v.enumName}.${v.name}`;
	}
	if (v instanceof VStruct || v instanceof VObject) {
		const fields = [...v.fields.entries()]
			.map(([name, value]) => `${name} := ${verseToDiagnostic(value)}`)
			.join(', ');
		return `${v.cls.name}{${fields}}`;
	}
	if (v instanceof VFunctionValue || v instanceof VNativeFunction) {
		return `function ${v.name}`;
	}
	if (v instanceof VTypeValue) {
		return `type ${v.name}`;
	}
	if (isTask(v)) {
		return 'task';
	}
	if (isEvent(v)) {
		return 'event';
	}
	return String(v);
}
