// registry.ts
// Native module registry: the single source of truth for builtin modules.
// Each entry carries the checker-facing signature (VTypes + effects), the
// runtime implementation, and documentation metadata for the IDE DocsPanel,
// hovers, and completions.

import { NativeExport } from '../../sema/scopes';
import { ClassInfo, EnumInfo, FuncT, T, VType } from '../../sema/types';
import { EffectSet, makeEffects } from '../../sema/effects';
import { Ctx } from '../context';
import { Failable, Value } from '../values';

export type NativeImpl = (args: Value[], ctx: Ctx) => Failable<Value> | Promise<Failable<Value>>;

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

export interface NativeModuleDef {
	path: string;
	description: string;
	entries: Map<string, NativeEntry>;
}

export class ModuleBuilder {
	def: NativeModuleDef;

	constructor(path: string, description: string) {
		this.def = { path, description, entries: new Map() };
	}

	fn(
		name: string,
		signature: { params: [string, VType][]; ret: VType; effects?: Partial<EffectSet> },
		impl: NativeImpl,
		doc: string,
		example?: string,
	): this {
		const funcType: FuncT = {
			k: 'func',
			params: signature.params.map(([paramName, type]) => ({
				name: paramName, type, named: false, hasDefault: false,
			})),
			ret: signature.ret,
			effects: makeEffects(signature.effects ?? {}),
			typeParams: [],
		};
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
	overload(name: string, signature: { params: [string, VType][]; ret: VType; effects?: Partial<EffectSet> }): this {
		const existing = this.def.entries.get(name);
		if (!existing || existing.kind !== 'function') {
			throw new Error(`overload() before fn() for ${name}`);
		}
		existing.signatures.push({
			k: 'func',
			params: signature.params.map(([paramName, type]) => ({
				name: paramName, type, named: false, hasDefault: false,
			})),
			ret: signature.ret,
			effects: makeEffects(signature.effects ?? {}),
			typeParams: [],
		});
		existing.paramNames.push(signature.params.map(([n]) => n));
		return this;
	}

	cls(
		name: string,
		info: ClassInfo,
		construct: NativeClassEntry['construct'],
		doc: string,
		example?: string,
	): this {
		this.def.entries.set(name, { kind: 'class', name, info, construct, doc, example });
		return this;
	}

	value(name: string, type: VType, value: Value, doc: string): this {
		this.def.entries.set(name, { kind: 'value', name, type, value, doc });
		return this;
	}
}

export class NativeRegistry {
	modules: Map<string, NativeModuleDef> = new Map();

	add(builder: ModuleBuilder): this {
		this.modules.set(builder.def.path, builder.def);
		return this;
	}

	/** Checker-facing catalog. */
	toCatalog(): { modules: Map<string, { path: string; description: string; exports: Map<string, NativeExport> }> } {
		const modules = new Map<string, { path: string; description: string; exports: Map<string, NativeExport> }>();
		for (const [path, def] of this.modules) {
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
		return { modules };
	}

	lookup(path: string, name: string): NativeEntry | null {
		return this.modules.get(path)?.entries.get(name) ?? null;
	}

	/** Find an entry by name across all modules (used by the compiler when a
	 * binding recorded only the export). */
	find(modulePath: string, name: string): NativeEntry | null {
		return this.lookup(modulePath, name);
	}
}

export function makeNumericHelpers() {
	return { T };
}
