// scopes.ts
// Name binding model: lexical scopes with slot allocation for function
// frames, module-level globals, class members, natives, and imports.

import { Expr, FunctionDef } from '../frontend/ast';
import { EffectSet } from './effects';
import { ClassInfo, EnumInfo, FuncT, VType } from './types';

export type AccessLevel = 'public' | 'private' | 'protected' | 'internal';

export interface NativeExport {
	kind: 'function' | 'class' | 'value' | 'enum';
	name: string;
	/** Function signatures (overloads) for kind=function. */
	signatures?: FuncT[];
	classInfo?: ClassInfo;
	enumInfo?: EnumInfo;
	valueType?: VType;
	doc?: string;
	example?: string;
	modulePath: string;
}

export interface Frame {
	slotCount: number;
}

export type Binding =
	| { kind: 'local'; name: string; slot: number; frameDepth: number; mutable: boolean; type: VType; frame?: Frame | null }
	| { kind: 'global'; name: string; slot: number; mutable: boolean; type: VType }
	| {
		kind: 'function'; name: string; slot: number; type: VType;
		overloads: { fn: FunctionDef; type: FuncT; slot: number }[];
	}
	| { kind: 'member'; name: string; classInfo: ClassInfo; type: VType; mutable: boolean; isMethod: boolean }
	| { kind: 'class'; name: string; classInfo: ClassInfo; declSlot: number }
	| { kind: 'enum'; name: string; enumInfo: EnumInfo }
	| { kind: 'module'; name: string; module: ModuleSymbol }
	| { kind: 'native'; name: string; export: NativeExport }
	| { kind: 'typeParam'; name: string; type: VType }
	| { kind: 'typeAlias'; name: string; type: VType };

export interface ModuleSymbol {
	name: string;
	path: string;
	scope: Scope;
	access: AccessLevel;
}

export class Scope {
	parent: Scope | null;
	bindings: Map<string, Binding> = new Map();
	/** 'function' scopes own a frame; 'block' scopes share the enclosing frame. */
	scopeKind: 'module' | 'class' | 'function' | 'block';
	/** For function scopes: the frame's slot counter. */
	frame: Frame | null;
	classInfo: ClassInfo | null;

	constructor(
		parent: Scope | null,
		scopeKind: Scope['scopeKind'],
		classInfo: ClassInfo | null = null,
	) {
		this.parent = parent;
		this.scopeKind = scopeKind;
		this.classInfo = classInfo;
		this.frame = scopeKind === 'function' ? { slotCount: 0 } : null;
	}

	define(name: string, binding: Binding): boolean {
		if (this.bindings.has(name)) {
			return false;
		}
		this.bindings.set(name, binding);
		return true;
	}

	lookupLocal(name: string): Binding | null {
		return this.bindings.get(name) ?? null;
	}

	lookup(name: string): Binding | null {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let scope: Scope | null = this;
		while (scope) {
			const found = scope.bindings.get(name);
			if (found) {
				return found;
			}
			scope = scope.parent;
		}
		return null;
	}

	/** The function frame this scope allocates locals into. */
	owningFrame(): Frame | null {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let scope: Scope | null = this;
		while (scope) {
			if (scope.frame) {
				return scope.frame;
			}
			scope = scope.parent;
		}
		return null;
	}

	/** Frames crossed from this scope up to the one owning `frame` (0 = own frame). */
	frameDepthTo(frame: Frame): number {
		let depth = 0;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		let scope: Scope | null = this;
		while (scope) {
			if (scope.frame) {
				if (scope.frame === frame) {
					return depth;
				}
				depth += 1;
			}
			scope = scope.parent;
		}
		return depth;
	}

	allocSlot(): number {
		const frame = this.owningFrame();
		if (!frame) {
			return -1;
		}
		const slot = frame.slotCount;
		frame.slotCount += 1;
		return slot;
	}
}

/** Per-function checking context. */
export interface FunctionContext {
	declaredEffects: EffectSet;
	inferred: EffectSet;
	returnType: VType;
	failureDepth: number;
	loopDepth: number;
	node: Expr | null;
	name: string;
	isConstructor: boolean;
}
