// registry.ts
// The native bindings registry: the single source of truth for host-provided
// Verse modules. Each entry carries the checker-facing signature (VTypes +
// effects), the runtime implementation, and documentation metadata that
// surfaces automatically in docs/hover/completion tooling.
//
// This is the public embedding API: hosts declare modules with
// `defineModule` and pass them to `createHost`. The bundled standard
// library (src/verse/stdlib) and the UEFN extras (src/verse/extras) are
// built exclusively through this same API.

import { NativeExport } from '../sema/scopes';
import { ClassInfo, EnumInfo, FuncT, makeClassInfo, T, VType } from '../sema/types';
import { EffectSet, makeEffects } from '../sema/effects';
import { Ctx } from '../runtime/context';
import { Failable, Value } from '../runtime/values';

/**
 * A native function implementation. Receives evaluated argument values and
 * the execution context; returns a Verse value, `FAIL` (for `<decides>`
 * functions), or a promise of either (for `<suspends>` functions).
 */
export type NativeImpl = (args: Value[], ctx: Ctx) => Failable<Value> | Promise<Failable<Value>>;

/**
 * A native method implementation on a native class. `self` is the receiver
 * value (which may be an engine value like a task rather than a Verse
 * object).
 */
export type NativeMethodImpl = (
	self: Value,
	args: Value[],
	ctx: Ctx,
) => Failable<Value> | Promise<Failable<Value>>;

/** A function signature in builder form: named params, return type, effects. */
export interface NativeSignature {
	params: [string, VType][];
	ret: VType;
	effects?: Partial<EffectSet>;
}

export interface NativeFunctionEntry {
	kind: 'function';
	name: string;
	signatures: FuncT[];
	paramNames: string[][];
	impl: NativeImpl;
	doc: string;
	example?: string;
}

export interface NativeClassEntry {
	kind: 'class';
	name: string;
	info: ClassInfo;
	/** Instantiate from archetype fields; null for non-constructible. */
	construct: ((fields: Map<string, Value>, ctx: Ctx) => Value) | null;
	/**
	 * Runtime type test for values of this class that are not plain Verse
	 * objects (e.g. tasks, events). Used for casts (`task[X]`) and native
	 * method dispatch.
	 */
	matches?: (value: Value) => boolean;
	/** Native method implementations, dispatched on values this entry `matches`. */
	methods?: Record<string, NativeMethodImpl>;
	doc: string;
	example?: string;
}

export interface NativeValueEntry {
	kind: 'value';
	name: string;
	type: VType;
	value: Value;
	doc: string;
}

export interface NativeEnumEntry {
	kind: 'enum';
	name: string;
	info: EnumInfo;
	doc: string;
}

export type NativeEntry = NativeFunctionEntry | NativeClassEntry | NativeValueEntry | NativeEnumEntry;

/**
 * An entry-point protocol contributed by a module: classes extending
 * `className` become program entry points, and the runtime invokes `method`
 * on an instance of each after top-level statements run. This is how the
 * UEFN extra wires `creative_device.OnBegin` without the compiler knowing
 * about devices.
 */
export interface EntryPointSpec {
	className: string;
	method: string;
}

/** A fully-built native module, ready to register with a host. */
export interface NativeModuleDef {
	path: string;
	description: string;
	entries: Map<string, NativeEntry>;
	/** Implicitly imported into every program (no `using` required). */
	implicit: boolean;
	/** Entry-point protocols contributed by this module. */
	entryPoints: EntryPointSpec[];
	/**
	 * Path namespaces this module vouches for: `using` an unknown module
	 * under one of these roots produces a warning ("not modeled") instead
	 * of an error, so programs written against a larger API surface still
	 * run.
	 */
	toleratedRoots: string[];
}

export interface ModuleOptions {
	/** Import this module into every program implicitly (like the prelude). */
	implicit?: boolean;
	/** Register an entry-point protocol (see {@link EntryPointSpec}). */
	entryPoint?: EntryPointSpec;
	/** Namespace roots to tolerate as "not modeled" warnings. */
	toleratedRoots?: string[];
}

/**
 * Declares the checker-facing shape of a native class. Returns a `ClassInfo`
 * that can be shared between modules (e.g. as a supertype) and passed to
 * {@link ModuleBuilder.cls}.
 */
export interface NativeClassSpec {
	name: string;
	kind?: 'class' | 'struct' | 'interface';
	supers?: ClassInfo[];
	abstract?: boolean;
	/** Identity-compared and usable where uniqueness is required (weak_map keys). */
	unique?: boolean;
	/** Usable as a failable cast target (`my_class[X]`). */
	castable?: boolean;
	methods?: { name: string; signature: NativeSignature }[];
	fields?: { name: string; type: VType; mutable?: boolean }[];
}

function toFuncT(signature: NativeSignature): FuncT {
	return {
		k: 'func',
		params: signature.params.map(([paramName, type]) => ({
			name: paramName, type, named: false, hasDefault: false,
		})),
		ret: signature.ret,
		effects: makeEffects(signature.effects ?? {}),
		typeParams: [],
	};
}

/** Builds a `ClassInfo` for a native class from a declarative spec. */
export function declareNativeClass(spec: NativeClassSpec): ClassInfo {
	const info = makeClassInfo(spec.name, spec.kind ?? 'class');
	info.native = true;
	info.abstract = spec.abstract ?? false;
	info.unique = spec.unique ?? false;
	info.castable = spec.castable ?? false;
	if (spec.supers) {
		info.supers.push(...spec.supers);
	}
	for (const method of spec.methods ?? []) {
		info.members.set(method.name, {
			name: method.name,
			type: toFuncT(method.signature),
			mutable: false,
			access: 'public',
			isMethod: true,
			hasBody: true,
			origin: info,
		});
	}
	for (const field of spec.fields ?? []) {
		info.members.set(field.name, {
			name: field.name,
			type: field.type,
			mutable: field.mutable ?? false,
			access: 'public',
			isMethod: false,
			hasBody: true,
			origin: info,
		});
	}
	return info;
}

/** Options for {@link ModuleBuilder.cls}. */
export interface ClassEntryOptions {
	construct?: NativeClassEntry['construct'];
	matches?: NativeClassEntry['matches'];
	methods?: NativeClassEntry['methods'];
	doc: string;
	example?: string;
}

/**
 * Fluent builder for a native module. Usually used through
 * {@link defineModule} rather than constructed directly.
 */
export class ModuleBuilder {
	def: NativeModuleDef;

	constructor(path: string, description: string, options: ModuleOptions = {}) {
		this.def = {
			path,
			description,
			entries: new Map(),
			implicit: options.implicit ?? false,
			entryPoints: options.entryPoint ? [options.entryPoint] : [],
			toleratedRoots: options.toleratedRoots ?? [],
		};
	}

	/**
	 * Registers a native function. Calling `fn` again with the same name
	 * adds an overload sharing the first registration's impl/doc.
	 */
	fn(
		name: string,
		signature: NativeSignature,
		impl: NativeImpl,
		doc: string,
		example?: string,
	): this {
		const funcType = toFuncT(signature);
		const existing = this.def.entries.get(name);
		if (existing && existing.kind === 'function') {
			existing.signatures.push(funcType);
			existing.paramNames.push(signature.params.map(([n]) => n));
			return this;
		}
		this.def.entries.set(name, {
			kind: 'function',
			name,
			signatures: [funcType],
			paramNames: [signature.params.map(([n]) => n)],
			impl,
			doc,
			example,
		});
		return this;
	}

	/** Adds an overload sharing the previous entry's impl/doc. */
	overload(name: string, signature: NativeSignature): this {
		const existing = this.def.entries.get(name);
		if (!existing || existing.kind !== 'function') {
			throw new Error(`overload() before fn() for ${name}`);
		}
		existing.signatures.push(toFuncT(signature));
		existing.paramNames.push(signature.params.map(([n]) => n));
		return this;
	}

	/**
	 * Registers a native class. The `info` (from {@link declareNativeClass})
	 * carries the checker-facing shape; `options` carry the runtime pieces:
	 * `construct` (archetype instantiation), `matches` (runtime type test
	 * for non-object values), and `methods` (native method impls).
	 */
	cls(name: string, info: ClassInfo, options: ClassEntryOptions): this {
		this.def.entries.set(name, {
			kind: 'class',
			name,
			info,
			construct: options.construct ?? null,
			matches: options.matches,
			methods: options.methods,
			doc: options.doc,
			example: options.example,
		});
		return this;
	}

	/** Registers a native enum type. */
	enum(name: string, info: EnumInfo, doc: string): this {
		this.def.entries.set(name, { kind: 'enum', name, info, doc });
		return this;
	}

	/** Registers a named constant. */
	value(name: string, type: VType, value: Value, doc: string): this {
		this.def.entries.set(name, { kind: 'value', name, type, value, doc });
		return this;
	}
}

/**
 * Declares a native module: the primary entry point of the bindings API.
 *
 * ```ts
 * const myModule = defineModule('/MyGame.com/Weather', 'Weather control.', (m) => {
 *   m.fn('SetRain', { params: [['Intensity', T.float]], ret: T.void },
 *     ([intensity]) => { engine.setRain(intensity as number); return undefined; },
 *     'Sets the rain intensity from 0.0 to 1.0.');
 * });
 * ```
 */
export function defineModule(
	path: string,
	description: string,
	build: (m: ModuleBuilder) => void,
	options: ModuleOptions = {},
): NativeModuleDef {
	const builder = new ModuleBuilder(path, description, options);
	build(builder);
	return builder.def;
}

/** Checker-facing view of a registry (types + docs, no implementations). */
export interface NativeCatalog {
	modules: Map<string, { path: string; description: string; exports: Map<string, NativeExport> }>;
	/** Module paths imported into every program without a `using`. */
	implicitPaths: string[];
	/** Entry-point protocols across all modules. */
	entryPoints: EntryPointSpec[];
	/** Namespace roots where unknown modules warn instead of erroring. */
	toleratedRoots: string[];
}

/**
 * The set of native modules available to a host. Registries are cheap,
 * isolated containers: two hosts with different registries never share
 * bindings.
 */
export class NativeRegistry {
	modules: Map<string, NativeModuleDef> = new Map();
	/** Flattened (matches, methods) list for value-method dispatch. */
	private methodDispatch: { matches: (v: Value) => boolean; methods: Record<string, NativeMethodImpl> }[] | null = null;

	add(module: NativeModuleDef | ModuleBuilder): this {
		const def = module instanceof ModuleBuilder ? module.def : module;
		this.modules.set(def.path, def);
		this.methodDispatch = null;
		return this;
	}

	addAll(modules: Iterable<NativeModuleDef>): this {
		for (const def of modules) {
			this.add(def);
		}
		return this;
	}

	/** Checker-facing catalog: signatures/docs only, no implementations. */
	toCatalog(): NativeCatalog {
		const modules = new Map<string, { path: string; description: string; exports: Map<string, NativeExport> }>();
		const implicitPaths: string[] = [];
		const entryPoints: EntryPointSpec[] = [];
		const toleratedRoots: string[] = [];
		for (const [path, def] of this.modules) {
			if (def.implicit) {
				implicitPaths.push(path);
			}
			entryPoints.push(...def.entryPoints);
			for (const root of def.toleratedRoots) {
				if (!toleratedRoots.includes(root)) {
					toleratedRoots.push(root);
				}
			}
			const exports = new Map<string, NativeExport>();
			for (const [name, entry] of def.entries) {
				if (entry.kind === 'function') {
					exports.set(name, {
						kind: 'function', name, signatures: entry.signatures,
						doc: entry.doc, example: entry.example, modulePath: path,
					});
				} else if (entry.kind === 'class') {
					exports.set(name, {
						kind: 'class', name, classInfo: entry.info,
						doc: entry.doc, example: entry.example, modulePath: path,
					});
				} else if (entry.kind === 'enum') {
					exports.set(name, {
						kind: 'enum', name, enumInfo: entry.info, doc: entry.doc, modulePath: path,
					});
				} else {
					exports.set(name, {
						kind: 'value', name, valueType: entry.type, doc: entry.doc, modulePath: path,
					});
				}
			}
			modules.set(path, { path, description: def.description, exports });
		}
		return { modules, implicitPaths, entryPoints, toleratedRoots };
	}

	lookup(path: string, name: string): NativeEntry | null {
		return this.modules.get(path)?.entries.get(name) ?? null;
	}

	/**
	 * Resolves a native method (e.g. `SomeTask.Await`) on a runtime value by
	 * asking each native class entry with a `matches` test.
	 */
	resolveValueMethod(value: Value, name: string): NativeMethodImpl | null {
		if (!this.methodDispatch) {
			this.methodDispatch = [];
			for (const def of this.modules.values()) {
				for (const entry of def.entries.values()) {
					if (entry.kind === 'class' && entry.matches && entry.methods) {
						this.methodDispatch.push({ matches: entry.matches, methods: entry.methods });
					}
				}
			}
		}
		for (const { matches, methods } of this.methodDispatch) {
			if (name in methods && matches(value)) {
				return methods[name];
			}
		}
		return null;
	}
}

// Re-exported so embedders can express signatures without reaching into
// sema/ internals.
export { T, makeEffects };
export type { VType, FuncT, ClassInfo, EnumInfo, EffectSet };
