// checker.ts
// Semantic analysis for Verse: scopes and name resolution (with slot
// allocation for the closure compiler), module/using resolution, class and
// enum registration, type checking with graceful degradation to `unknown`,
// and effect checking (suspends legality, failure-context requirements,
// computes purity).
//
// The checker decorates AST nodes in place via `node.sema`; the closure
// compiler in ../runtime/compile-closures.ts consumes those decorations.

import {
	Archetype, Attribute, Call, CaseExpr, ClassDef, Definition, Expr,
	ForExpr, ForGenerator, FunctionDef, IfExpr, ModuleDef, Param, Program,
	SetExpr, Specifier, VarDefinition,
} from '../frontend/ast';
import { Span } from '../frontend/tokens';
import { Diagnostic, diagnosticAt } from './diagnostics';
import {
	defaultEffects, EffectSet, makeEffects, resolveEffectSpecifiers, unionEffects,
} from './effects';
import {
	AccessLevel, Binding, FunctionContext, ModuleSymbol, NativeExport, Scope,
} from './scopes';
import {
	ClassInfo, EnumInfo, FuncT, isSubtype, joinTypes, makeClassInfo, MemberInfo,
	Substitution, substitute, T, typeToString, TypeParamT, unify, VType,
} from './types';

export interface SemaData {
	binding?: Binding;
	type?: VType;
	slot?: number;
	selfSlot?: number;
	frameDepth?: number;
	frameSize?: number;
	classInfo?: ClassInfo;
	enumInfo?: EnumInfo;
	memberMode?: 'dynamic' | 'binding' | 'enumValue' | 'super' | 'extension';
	memberBinding?: Binding;
	enumValueName?: string;
	extensionSlot?: number;
	callMode?: 'invoke' | 'cast' | 'index' | 'construct';
	isExtension?: boolean;
	modulePath?: string;
	failable?: boolean;
	/** Lexical scope active while checking this expression (for IDE tooling). */
	scope?: Scope;
	/** Resolved member info for dynamic member access (for IDE tooling). */
	memberInfo?: MemberInfo;
}

export function semaOf(node: Expr): SemaData {
	const holder = node as unknown as { sema?: SemaData };
	if (!holder.sema) {
		holder.sema = {};
	}
	return holder.sema;
}

export interface NativeCatalog {
	modules: Map<string, { path: string; description: string; exports: Map<string, NativeExport> }>;
	/** Module paths imported into every program without a `using`. */
	implicitPaths: string[];
	/** Entry-point protocols: classes extending `className` run `method`. */
	entryPoints: { className: string; method: string }[];
	/** Namespace roots where unknown modules warn instead of erroring. */
	toleratedRoots: string[];
}

/** A user class selected as a program entry point by a registered protocol. */
export interface EntryClass {
	def: ClassDef;
	/** Method the runtime invokes on an instance (e.g. 'OnBegin'). */
	method: string;
}

export interface CheckResult {
	diagnostics: Diagnostic[];
	globalSlotCount: number;
	/** Classes matching a registered entry-point protocol, in source order. */
	entryClasses: EntryClass[];
	topLevelStatements: Expr[];
	/** Top-level scope with all module definitions + imported natives. */
	moduleScope: Scope;
}

const ACCESS_SPECIFIERS = new Set(['public', 'private', 'protected', 'internal', 'scoped', 'epic_internal']);
const CLASS_ONLY_SPECIFIERS = new Set(['abstract', 'concrete', 'final', 'unique', 'castable', 'persistable', 'final_super', 'final_super_base', 'computes', 'transacts', 'varies', 'converges', 'epic_internal', 'public', 'internal', 'open', 'closed']);

export function checkProgram(program: Program, natives: NativeCatalog): CheckResult {
	const checker = new Checker(natives);
	checker.check(program);
	return {
		diagnostics: checker.diagnostics,
		globalSlotCount: checker.globalSlotCount,
		entryClasses: checker.entryClasses,
		topLevelStatements: checker.topLevelStatements,
		moduleScope: checker.moduleScope,
	};
}

class Checker {
	diagnostics: Diagnostic[] = [];
	natives: NativeCatalog;
	globalSlotCount = 0;
	entryClasses: EntryClass[] = [];
	topLevelStatements: Expr[] = [];
	moduleScope: Scope;
	private fnStack: FunctionContext[] = [];
	private classStack: ClassInfo[] = [];
	private scope: Scope;
	private usedPaths: Set<string> = new Set();
	/** name -> extension methods on that name. */
	private extensions: Map<string, { target: VType; type: FuncT; slot: number; fn: FunctionDef }[]> = new Map();

	constructor(natives: NativeCatalog) {
		this.natives = natives;
		this.moduleScope = new Scope(null, 'module');
		this.scope = this.moduleScope;
	}

	private error(message: string, span: Span | null, code?: string): void {
		this.diagnostics.push(diagnosticAt(message, span, 'error', code));
	}

	private warning(message: string, span: Span | null): void {
		this.diagnostics.push(diagnosticAt(message, span, 'warning'));
	}

	private allocGlobal(): number {
		return this.globalSlotCount++;
	}

	private currentFn(): FunctionContext | null {
		return this.fnStack[this.fnStack.length - 1] ?? null;
	}

	// =====================================================================
	// Program entry
	// =====================================================================

	check(program: Program): void {
		// Implicit modules (the prelude, by default) are always in scope.
		for (const path of this.natives.implicitPaths) {
			this.importNativeModule(path, null);
		}

		// Apply native `using` imports up front so class headers resolving
		// creative_device/event/... see them regardless of statement order.
		const applyNativeUsings = (body: Expr[]) => {
			for (const stmt of body) {
				if (stmt.kind === 'UsingDecl' && stmt.path.startsWith('/')) {
					this.applyUsing(stmt.path, stmt.span);
				} else if (stmt.kind === 'ModuleDef') {
					applyNativeUsings(stmt.members);
				}
			}
		};
		applyNativeUsings(program.body);

		this.collectDefinitions(program.body, this.moduleScope, '(main)');
		this.resolveSignatures(program.body, this.moduleScope);
		for (const stmt of program.body) {
			this.checkTopLevel(stmt);
		}
	}

	private checkTopLevel(stmt: Expr): void {
		switch (stmt.kind) {
			case 'UsingDecl':
				this.applyUsing(stmt.path, stmt.span);
				return;
			case 'ClassDef':
				this.checkClassDef(stmt);
				return;
			case 'ModuleDef':
				this.checkModuleDef(stmt);
				return;
			case 'EnumDef':
			case 'TypeAliasDef':
				return; // handled in collect/resolve
			case 'FunctionDef':
				this.checkFunctionDef(stmt, null);
				return;
			case 'Definition':
				this.checkGlobalDefinition(stmt);
				return;
			case 'VarDefinition':
				this.checkGlobalVar(stmt);
				return;
			default:
				// Script-style top-level statement (runs before OnBegin).
				this.topLevelStatements.push(stmt);
				this.withFunction(this.makeScriptContext(), () => {
					this.checkInScriptFrame(stmt);
				});
				return;
		}
	}

	/**
	 * Checks an expression inside its own mini function frame (used for
	 * top-level statements, global/field initializers, and block clauses).
	 * The frame size is recorded on the node for the closure compiler.
	 */
	private checkInScriptFrame(expr: Expr, expected?: VType): VType {
		const frameScope = new Scope(this.scope, 'function');
		const previous = this.scope;
		this.scope = frameScope;
		try {
			const type = this.checkExpr(expr, expected);
			semaOf(expr).frameSize = frameScope.frame?.slotCount ?? 0;
			return type;
		} finally {
			this.scope = previous;
		}
	}

	private makeScriptContext(): FunctionContext {
		return {
			declaredEffects: makeEffects({
				suspends: true, reads: true, writes: true, allocates: true,
				diverges: true, dictates: true,
			}),
			inferred: makeEffects(),
			returnType: T.void,
			failureDepth: 0,
			loopDepth: 0,
			node: null,
			name: '(top level)',
			isConstructor: false,
		};
	}

	// =====================================================================
	// Pass 1: collect definitions (order-independent at module/class scope)
	// =====================================================================

	private collectDefinitions(body: Expr[], scope: Scope, modulePath: string): void {
		for (const stmt of body) {
			switch (stmt.kind) {
				case 'ClassDef': {
					const info = makeClassInfo(stmt.name, stmt.classKind);
					info.modulePath = modulePath;
					this.applyClassSpecifiers(info, stmt.specifiers, stmt.span);
					const declSlot = this.allocGlobal();
					semaOf(stmt).classInfo = info;
					semaOf(stmt).slot = declSlot;
					if (!scope.define(stmt.name, { kind: 'class', name: stmt.name, classInfo: info, declSlot, declSpan: stmt.span })) {
						this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
					}
					break;
				}
				case 'EnumDef': {
					const info: EnumInfo = {
						name: stmt.name,
						values: stmt.values.map((v) => v.name),
						open: stmt.specifiers.some((s) => s.name === 'open'),
						modulePath,
					};
					semaOf(stmt).enumInfo = info;
					if (!scope.define(stmt.name, { kind: 'enum', name: stmt.name, enumInfo: info, declSpan: stmt.span })) {
						this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
					}
					break;
				}
				case 'ModuleDef': {
					const subScope = new Scope(scope, 'module');
					const subPath = `${modulePath}/${stmt.name}`;
					const moduleSymbol: ModuleSymbol = {
						name: stmt.name,
						path: subPath,
						scope: subScope,
						access: this.accessFromSpecifiers(stmt.specifiers),
					};
					semaOf(stmt).modulePath = subPath;
					if (!scope.define(stmt.name, { kind: 'module', name: stmt.name, module: moduleSymbol, declSpan: stmt.span })) {
						this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
					}
					this.collectDefinitions(stmt.members, subScope, subPath);
					break;
				}
				case 'FunctionDef': {
					if (stmt.extensionTarget) {
						// Extension method: registered separately, dispatched
						// through member access.
						const slot = this.allocGlobal();
						semaOf(stmt).slot = slot;
						semaOf(stmt).isExtension = true;
						break;
					}
					const existing = scope.lookupLocal(stmt.name);
					if (existing && existing.kind === 'function') {
						const slot = this.allocGlobal();
						existing.overloads.push({ fn: stmt, type: this.placeholderFuncType(stmt), slot });
						semaOf(stmt).slot = slot;
					} else {
						const slot = this.allocGlobal();
						const binding: Binding = {
							kind: 'function',
							name: stmt.name,
							slot,
							type: T.unknown,
							overloads: [{ fn: stmt, type: this.placeholderFuncType(stmt), slot }],
							declSpan: stmt.span,
						};
						semaOf(stmt).slot = slot;
						if (!scope.define(stmt.name, binding)) {
							this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
						}
					}
					break;
				}
				case 'Definition': {
					const slot = this.allocGlobal();
					semaOf(stmt).slot = slot;
					if (!scope.define(stmt.name, {
						kind: 'global', name: stmt.name, slot, mutable: false, type: T.unknown, declSpan: stmt.span,
					})) {
						this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
					}
					break;
				}
				case 'VarDefinition': {
					const slot = this.allocGlobal();
					semaOf(stmt).slot = slot;
					if (!scope.define(stmt.name, {
						kind: 'global', name: stmt.name, slot, mutable: true, type: T.unknown, declSpan: stmt.span,
					})) {
						this.error(`Duplicate definition of '${stmt.name}'`, stmt.span);
					}
					break;
				}
				case 'TypeAliasDef': {
					// Resolved in pass 2 (may reference later classes).
					break;
				}
				default:
					break;
			}
		}
	}

	private placeholderFuncType(fn: FunctionDef): FuncT {
		return {
			k: 'func',
			params: fn.params.map((p) => ({ name: p.name, type: T.unknown, named: p.named, hasDefault: p.defaultValue !== null })),
			ret: T.unknown,
			effects: defaultEffects(),
			typeParams: [],
		};
	}

	// =====================================================================
	// Pass 2: resolve signatures (types now that all names exist)
	// =====================================================================

	private resolveSignatures(body: Expr[], scope: Scope): void {
		const previous = this.scope;
		this.scope = scope;
		for (const stmt of body) {
			switch (stmt.kind) {
				case 'ClassDef':
					this.resolveClassSignature(stmt, scope);
					break;
				case 'ModuleDef': {
					const binding = scope.lookupLocal(stmt.name);
					if (binding?.kind === 'module') {
						this.resolveSignatures(stmt.members, binding.module.scope);
					}
					break;
				}
				case 'FunctionDef': {
					if (stmt.extensionTarget) {
						const target = this.resolveTypeExpr(stmt.extensionTarget);
						const type = this.resolveFunctionType(stmt);
						const list = this.extensions.get(stmt.name) ?? [];
						list.push({ target, type, slot: semaOf(stmt).slot ?? -1, fn: stmt });
						this.extensions.set(stmt.name, list);
						break;
					}
					const binding = scope.lookupLocal(stmt.name);
					if (binding?.kind === 'function') {
						const entry = binding.overloads.find((o) => o.fn === stmt);
						if (entry) {
							entry.type = this.resolveFunctionType(stmt);
						}
					}
					break;
				}
				case 'TypeAliasDef': {
					const type = this.resolveTypeExpr(stmt.value);
					scope.define(stmt.name, { kind: 'typeAlias', name: stmt.name, type, declSpan: stmt.span });
					semaOf(stmt).type = type;
					break;
				}
				case 'Definition': {
					const binding = scope.lookupLocal(stmt.name);
					if (binding?.kind === 'global' && stmt.type) {
						binding.type = this.resolveTypeExpr(stmt.type);
					}
					break;
				}
				case 'VarDefinition': {
					const binding = scope.lookupLocal(stmt.name);
					if (binding?.kind === 'global' && stmt.type) {
						binding.type = this.resolveTypeExpr(stmt.type);
					}
					break;
				}
				default:
					break;
			}
		}
		this.scope = previous;
	}

	private resolveClassSignature(stmt: ClassDef, scope: Scope): void {
		const info = semaOf(stmt).classInfo;
		if (!info) {
			return;
		}
		// Type parameters.
		for (const tp of stmt.typeParams) {
			const constraint = tp.type ? this.resolveTypeExpr(tp.type) : null;
			info.typeParams.push(T.typeParam(tp.name, constraint && constraint.k !== 'type' ? constraint : null));
		}
		// Supers.
		for (const superExpr of stmt.supers) {
			const superType = this.resolveTypeExpr(superExpr);
			if (superType.k === 'class') {
				if (superType.info.final) {
					this.error(`Cannot inherit from final ${superType.info.kind} '${superType.info.name}'`, superExpr.span);
				}
				info.supers.push(superType.info);
			} else if (superType.k !== 'unknown') {
				this.error(`'${typeToString(superType)}' is not a class or interface`, superExpr.span);
			}
		}
		if (info.supers.filter((s) => s.kind === 'class').length > 1) {
			this.error(`'${info.name}' inherits from more than one class (only one class plus interfaces is allowed)`, stmt.span);
		}
		// Members (with type-param scope for parametric classes).
		const classTypeScope = new Scope(scope, 'block');
		for (const tp of info.typeParams) {
			classTypeScope.define(tp.name, { kind: 'typeParam', name: tp.name, type: tp });
		}
		const previous = this.scope;
		this.scope = classTypeScope;
		for (const member of stmt.members) {
			this.registerClassMember(info, member);
		}
		this.scope = previous;

		// Entry-point protocols from the registry (e.g. the UEFN extra marks
		// classes extending creative_device to have OnBegin invoked).
		for (const entryPoint of this.natives.entryPoints) {
			if (this.classExtendsNative(info, entryPoint.className)) {
				this.entryClasses.push({ def: stmt, method: entryPoint.method });
				break;
			}
		}
	}

	private registerClassMember(info: ClassInfo, member: Expr): void {
		if (member.kind === 'FunctionDef') {
			const fnType = this.resolveFunctionType(member);
			const existing = info.members.get(member.name);
			const memberInfo: MemberInfo = existing ?? {
				name: member.name,
				type: fnType,
				mutable: false,
				access: this.accessFromSpecifiers(member.specifiers),
				isMethod: true,
				hasBody: member.body !== null,
				overloads: [],
				origin: info,
				declSpan: member.span,
			};
			memberInfo.overloads = memberInfo.overloads ?? [];
			memberInfo.overloads.push(fnType);
			memberInfo.type = fnType;
			memberInfo.hasBody = memberInfo.hasBody || member.body !== null;
			info.members.set(member.name, memberInfo);
			if (member.body === null && !info.abstract && info.kind === 'class') {
				this.error(
					`'${member.name}' has no implementation; the class must be <abstract> or the method must have a body`,
					member.span,
				);
			}
		} else if (member.kind === 'Definition' || member.kind === 'VarDefinition') {
			const declared = member.type ? this.resolveTypeExpr(member.type) : T.unknown;
			info.members.set(member.name, {
				name: member.name,
				type: declared,
				mutable: member.kind === 'VarDefinition',
				access: this.accessFromSpecifiers(member.specifiers),
				isMethod: false,
				hasBody: member.value !== null,
				origin: info,
				declSpan: member.span,
			});
		}
	}

	private resolveFunctionType(fn: FunctionDef): FuncT {
		// where-clause type params visible in the signature.
		const typeParams: TypeParamT[] = [];
		const typeParamScope = new Scope(this.scope, 'block');
		for (const clause of fn.where) {
			const constraintType = clause.constraint ? this.resolveTypeExprIn(clause.constraint, typeParamScope) : null;
			const tp = T.typeParam(clause.name, constraintType && constraintType.k !== 'type' ? constraintType : null);
			typeParams.push(tp);
			typeParamScope.define(clause.name, { kind: 'typeParam', name: clause.name, type: tp });
		}
		const params = fn.params.map((p) => ({
			name: p.name,
			type: p.type ? this.resolveTypeExprIn(p.type, typeParamScope) : T.unknown,
			named: p.named,
			hasDefault: p.defaultValue !== null,
		}));
		const ret = fn.returnType ? this.resolveTypeExprIn(fn.returnType, typeParamScope) : T.unknown;
		const { effects, errors } = resolveEffectSpecifiers(fn.effects);
		for (const message of errors) {
			this.error(message, fn.span);
		}
		return { k: 'func', params, ret, effects, typeParams };
	}

	// =====================================================================
	// using / native modules
	// =====================================================================

	private applyUsing(path: string, span: Span): void {
		if (this.usedPaths.has(path)) {
			return;
		}
		this.usedPaths.add(path);
		if (path.startsWith('/')) {
			if (!this.importNativeModule(path, span)) {
				this.error(`Unknown module path '${path}'`, span, 'unknown-module');
			}
			return;
		}
		// Local module: bring its members into scope.
		const binding = this.scope.lookup(path);
		if (binding?.kind === 'module') {
			for (const [name, memberBinding] of binding.module.scope.bindings) {
				this.moduleScope.define(name, memberBinding);
			}
			return;
		}
		this.error(`Unknown module '${path}' in using declaration`, span, 'unknown-module');
	}

	private importNativeModule(path: string, span: Span | null): boolean {
		const nativeModule = this.natives.modules.get(path);
		if (!nativeModule) {
			// Registered namespace roots (e.g. /Fortnite.com from the UEFN
			// extra) tolerate unmodeled paths with a warning rather than
			// failing whole programs.
			if (span && this.natives.toleratedRoots.some((root) => path.startsWith(root))) {
				this.warning(`Module '${path}' is not modeled in this environment; its symbols are unavailable`, span);
				return true;
			}
			return false;
		}
		for (const [name, exp] of nativeModule.exports) {
			this.moduleScope.define(name, { kind: 'native', name, export: exp });
		}
		return true;
	}

	// =====================================================================
	// Declarations at module level
	// =====================================================================

	private checkGlobalDefinition(stmt: Definition): void {
		const binding = this.scope.lookup(stmt.name);
		const declared = stmt.type ? this.resolveTypeExpr(stmt.type) : null;
		if (stmt.value) {
			const valueType = this.withFunction(this.makeScriptContext(), () =>
				this.checkInScriptFrame(stmt.value as Expr, declared ?? undefined));
			if (declared && !isSubtype(valueType, declared)) {
				this.error(
					`Cannot initialize '${stmt.name}' of type ${typeToString(declared)} with a value of type ${typeToString(valueType)}`,
					stmt.span, 'type-mismatch',
				);
			}
			if (binding?.kind === 'global') {
				binding.type = declared ?? valueType;
			}
		} else if (!declared) {
			this.error(`'${stmt.name}' needs a type or an initial value`, stmt.span);
		}
	}

	private checkGlobalVar(stmt: VarDefinition): void {
		const binding = this.scope.lookup(stmt.name);
		const declared = stmt.type ? this.resolveTypeExpr(stmt.type) : null;
		// Persistence validation for module-scoped weak_maps.
		if (declared && declared.k === 'map' && declared.weak) {
			this.checkPersistableValueType(declared.value, stmt.span);
		}
		if (stmt.value) {
			const valueType = this.withFunction(this.makeScriptContext(), () =>
				this.checkInScriptFrame(stmt.value as Expr, declared ?? undefined));
			if (declared && !isSubtype(valueType, declared)) {
				this.error(
					`Cannot initialize '${stmt.name}' of type ${typeToString(declared)} with a value of type ${typeToString(valueType)}`,
					stmt.span, 'type-mismatch',
				);
			}
			if (binding?.kind === 'global') {
				binding.type = declared ?? valueType;
			}
		} else {
			this.error(`'var ${stmt.name}' needs an initial value`, stmt.span);
		}
	}

	private checkPersistableValueType(t: VType, span: Span): void {
		if (t.k === 'class') {
			if (!t.info.persistable) {
				this.error(
					`weak_map value type '${t.info.name}' must be <persistable> for module-scoped persistence`,
					span, 'not-persistable',
				);
			}
			return;
		}
		if (t.k === 'option') {
			this.checkPersistableValueType(t.inner, span);
			return;
		}
		if (t.k === 'array') {
			this.checkPersistableValueType(t.element, span);
			return;
		}
		if (t.k === 'map') {
			this.checkPersistableValueType(t.value, span);
			return;
		}
		if (t.k === 'func') {
			this.error('Function types are not persistable', span, 'not-persistable');
		}
	}

	// =====================================================================
	// Classes
	// =====================================================================

	private applyClassSpecifiers(info: ClassInfo, specifiers: Specifier[], span: Span): void {
		for (const spec of specifiers) {
			switch (spec.name) {
				case 'abstract': info.abstract = true; break;
				case 'final': info.final = true; break;
				case 'unique': info.unique = true; info.castable = true; break;
				case 'castable': info.castable = true; break;
				case 'concrete': info.concrete = true; break;
				case 'persistable': info.persistable = true; break;
				default:
					if (!CLASS_ONLY_SPECIFIERS.has(spec.name) && !ACCESS_SPECIFIERS.has(spec.name)) {
						this.warning(`Unknown class specifier '<${spec.name}>'`, span);
					}
			}
		}
		if (info.persistable) {
			info.final = true;
		}
	}

	private classExtendsNative(info: ClassInfo, nativeName: string): boolean {
		if (info.name === nativeName) {
			return true;
		}
		return info.supers.some((s) => this.classExtendsNative(s, nativeName));
	}

	private checkClassDef(stmt: ClassDef): void {
		const info = semaOf(stmt).classInfo;
		if (!info) {
			return;
		}

		if (info.persistable) {
			this.validatePersistableClass(stmt, info);
		}

		const classScope = new Scope(this.scope, 'class', info);
		for (const tp of info.typeParams) {
			classScope.define(tp.name, { kind: 'typeParam', name: tp.name, type: tp });
		}
		// Members (own + inherited) resolve unqualified inside the class.
		const seen = new Set<string>();
		const addMembers = (ci: ClassInfo) => {
			for (const [name, member] of ci.members) {
				if (!seen.has(name)) {
					seen.add(name);
					classScope.define(name, {
						kind: 'member', name, classInfo: ci, type: member.type,
						mutable: member.mutable, isMethod: member.isMethod,
						declSpan: member.declSpan ?? undefined,
					});
				}
			}
			for (const parent of ci.supers) {
				addMembers(parent);
			}
		};
		addMembers(info);

		const previousScope = this.scope;
		this.scope = classScope;
		this.classStack.push(info);

		for (const member of stmt.members) {
			if (member.kind === 'FunctionDef') {
				this.checkOverride(info, member);
				this.checkFunctionDef(member, info);
			} else if (member.kind === 'Definition' || member.kind === 'VarDefinition') {
				if (member.value) {
					const declared = member.type ? this.resolveTypeExpr(member.type) : undefined;
					const valueType = this.withFunction(this.makeFieldInitContext(), () =>
						this.checkInScriptFrame(member.value as Expr, declared));
					if (declared && !isSubtype(valueType, declared)) {
						this.error(
							`Field '${member.name}' of type ${typeToString(declared)} cannot be initialized with ${typeToString(valueType)}`,
							member.span, 'type-mismatch',
						);
					}
					const registered = info.members.get(member.name);
					if (registered && registered.type.k === 'unknown') {
						registered.type = valueType;
					}
				} else if (!member.type) {
					this.error(`Field '${member.name}' needs a type or a default value`, member.span);
				}
			}
		}
		for (const blockClause of stmt.blocks) {
			this.withFunction(this.makeScriptContext(), () => {
				this.checkInScriptFrame(blockClause);
			});
		}

		this.classStack.pop();
		this.scope = previousScope;
	}

	private makeFieldInitContext(): FunctionContext {
		return {
			declaredEffects: makeEffects({ reads: true, allocates: true, diverges: true, dictates: true }),
			inferred: makeEffects(),
			returnType: T.unknown,
			failureDepth: 0,
			loopDepth: 0,
			node: null,
			name: '(field initializer)',
			isConstructor: false,
		};
	}

	private validatePersistableClass(stmt: ClassDef, info: ClassInfo): void {
		if (info.kind === 'interface') {
			this.error('Interfaces cannot be <persistable>', stmt.span);
		}
		if (info.kind === 'class' && !stmt.specifiers.some((s) => s.name === 'final')) {
			this.error("A <persistable> class must also be marked <final>", stmt.span, 'persistable-final');
		}
		if (info.typeParams.length > 0) {
			this.error('Persistable types cannot be parametric', stmt.span);
		}
		if (info.supers.length > 0) {
			this.error('Persistable types cannot have a superclass or interfaces', stmt.span);
		}
		if (info.abstract) {
			this.error('Persistable types cannot be <abstract>', stmt.span);
		}
		for (const member of stmt.members) {
			if (member.kind === 'VarDefinition') {
				this.error(`Persistable types cannot have 'var' fields ('${member.name}')`, member.span);
			}
			if (member.kind === 'FunctionDef' && member.body !== null) {
				// Methods are allowed on persistable classes in Verse.
			}
		}
	}

	private checkOverride(info: ClassInfo, member: FunctionDef): void {
		const hasOverride = member.specifiers.some((s) => s.name === 'override');
		const inherited = info.supers.some((s) => this.lookupMember(s, member.name) !== null);
		if (hasOverride && !inherited) {
			this.error(
				`'${member.name}' is marked <override> but no base class or interface declares it`,
				member.span, 'bad-override',
			);
		}
		if (!hasOverride && inherited) {
			this.error(
				`'${member.name}' overrides an inherited member and must be marked <override>`,
				member.span, 'missing-override',
			);
		}
	}

	lookupMember(info: ClassInfo, name: string): MemberInfo | null {
		const own = info.members.get(name);
		if (own) {
			return own;
		}
		for (const parent of info.supers) {
			const found = this.lookupMember(parent, name);
			if (found) {
				return found;
			}
		}
		return null;
	}

	// =====================================================================
	// Modules
	// =====================================================================

	private checkModuleDef(stmt: ModuleDef): void {
		const binding = this.scope.lookup(stmt.name);
		if (binding?.kind !== 'module') {
			return;
		}
		const previous = this.scope;
		this.scope = binding.module.scope;
		for (const member of stmt.members) {
			this.checkTopLevel(member);
		}
		this.scope = previous;
	}

	// =====================================================================
	// Functions
	// =====================================================================

	private checkFunctionDef(fn: FunctionDef, owner: ClassInfo | null): void {
		const fnType = this.resolveFunctionType(fn);
		semaOf(fn).type = fnType;

		if (fn.body === null) {
			return; // abstract/interface method
		}

		const fnScope = new Scope(this.scope, 'function');
		for (const tp of fnType.typeParams) {
			fnScope.define(tp.name, { kind: 'typeParam', name: tp.name, type: tp });
		}
		const paramSlots: number[] = [];
		fn.params.forEach((param, index) => {
			const slot = fnScope.allocSlot();
			paramSlots.push(slot);
			fnScope.define(param.name, {
				kind: 'local', name: param.name, slot, frameDepth: 0,
				mutable: false, type: fnType.params[index].type, frame: fnScope.frame,
				declSpan: param.span,
			});
			(param as Param & { sema?: SemaData }).sema = { slot };
		});
		// Extension methods get an implicit receiver of the target type.
		if (fn.extensionTarget) {
			semaOf(fn).isExtension = true;
			const selfName = fn.extensionSelfName ?? 'Self';
			const selfSlot = fnScope.allocSlot();
			semaOf(fn).selfSlot = selfSlot;
			fnScope.define(selfName, {
				kind: 'local', name: selfName, slot: selfSlot, frameDepth: 0,
				mutable: false, type: this.resolveTypeExpr(fn.extensionTarget), frame: fnScope.frame,
			});
		}

		const context: FunctionContext = {
			declaredEffects: fnType.effects,
			inferred: makeEffects(),
			returnType: fnType.ret,
			failureDepth: fnType.effects.decides ? 1 : 0,
			loopDepth: 0,
			node: fn,
			name: fn.name,
			isConstructor: fn.specifiers.some((s) => s.name === 'constructor'),
		};

		const previousScope = this.scope;
		this.scope = fnScope;
		const bodyType = this.withFunction(context, () => this.checkExpr(fn.body as Expr, fnType.ret));
		this.scope = previousScope;

		semaOf(fn).frameSize = fnScope.frame?.slotCount ?? 0;

		if (
			fnType.ret.k !== 'void' && fnType.ret.k !== 'unknown' && bodyType.k !== 'never' &&
			!isSubtype(bodyType, fnType.ret)
		) {
			this.error(
				`'${fn.name}' returns ${typeToString(fnType.ret)} but its body produces ${typeToString(bodyType)}`,
				fn.span, 'return-type',
			);
		}
		void owner;
	}

	private withFunction<TResult>(context: FunctionContext, body: () => TResult): TResult {
		this.fnStack.push(context);
		try {
			return body();
		} finally {
			this.fnStack.pop();
		}
	}

	// =====================================================================
	// Type expression resolution
	// =====================================================================

	resolveTypeExpr(expr: Expr): VType {
		return this.resolveTypeExprIn(expr, this.scope);
	}

	private resolveTypeExprIn(expr: Expr, scope: Scope): VType {
		switch (expr.kind) {
			case 'Ident':
				return this.resolveNamedType(expr.name, expr.span, scope);
			case 'OptionType':
				return T.option(this.resolveTypeExprIn(expr.inner, scope));
			case 'ArrayType':
				return T.array(this.resolveTypeExprIn(expr.element, scope));
			case 'MapType':
				return T.map(this.resolveTypeExprIn(expr.key, scope), this.resolveTypeExprIn(expr.value, scope));
			case 'TupleType':
				return T.tuple(expr.elements.map((e) => this.resolveTypeExprIn(e, scope)));
			case 'FunctionType': {
				const { effects } = resolveEffectSpecifiers(expr.effects);
				const fn = T.func(expr.params.map((p) => this.resolveTypeExprIn(p, scope)), this.resolveTypeExprIn(expr.result, scope));
				fn.effects = effects;
				return fn;
			}
			case 'GenericType': {
				const baseName = expr.base.kind === 'Ident' ? expr.base.name : null;
				if (baseName === 'weak_map' && expr.args.length === 2) {
					return T.map(
						this.resolveTypeExprIn(expr.args[0], scope),
						this.resolveTypeExprIn(expr.args[1], scope),
						true,
					);
				}
				if (baseName === 'subtype' || baseName === 'castable_subtype' || baseName === 'concrete_subtype') {
					const inner = expr.args.length === 1 ? this.resolveTypeExprIn(expr.args[0], scope) : T.any;
					return T.typeValue(inner);
				}
				if (baseName === 'task' && expr.args.length === 1) {
					return this.resolveNamedType('task', expr.span, scope);
				}
				if (baseName === 'event') {
					return this.resolveNamedType('event', expr.span, scope);
				}
				const base = this.resolveTypeExprIn(expr.base, scope);
				if (base.k === 'class') {
					return T.classType(base.info, expr.args.map((a) => this.resolveTypeExprIn(a, scope)));
				}
				return base;
			}
			case 'Member': {
				// Qualified type name: Module.type
				const target = this.resolveModuleRef(expr.target, scope);
				if (target) {
					const binding = target.scope.lookup(expr.name);
					if (binding) {
						return this.bindingToType(binding, expr.span);
					}
				}
				return T.unknown;
			}
			case 'TypeLit':
				return T.unknown; // opaque type{...} expression
			case 'Tuple':
				return T.tuple(expr.elements.map((e) => this.resolveTypeExprIn(e, scope)));
			default:
				this.error('Expected a type expression', expr.span);
				return T.unknown;
		}
	}

	private resolveModuleRef(expr: Expr, scope: Scope): ModuleSymbol | null {
		if (expr.kind === 'Ident') {
			const binding = scope.lookup(expr.name);
			if (binding?.kind === 'module') {
				return binding.module;
			}
		}
		return null;
	}

	private resolveNamedType(name: string, span: Span, scope: Scope): VType {
		switch (name) {
			case 'int': return T.int;
			case 'float': return T.float;
			case 'rational': return T.rational;
			case 'logic': return T.logic;
			case 'char': case 'char8': return T.char;
			case 'char32': return T.char32;
			case 'string': return T.string;
			case 'void': return T.void;
			case 'any': return T.any;
			case 'comparable': return T.comparable;
			case 'type': return T.type;
			case 'float16': case 'float32': case 'float64': case 'float128': return T.float;
			case 'int8': case 'int16': case 'int32': case 'int64':
			case 'nat': case 'nat8': case 'nat16': case 'nat32': case 'nat64': return T.int;
			default:
				break;
		}
		const binding = scope.lookup(name);
		if (!binding) {
			this.error(`Unknown type '${name}'`, span, 'unknown-type');
			return T.unknown;
		}
		return this.bindingToType(binding, span);
	}

	private bindingToType(binding: Binding, span: Span): VType {
		switch (binding.kind) {
			case 'class': return T.classType(binding.classInfo);
			case 'enum': return T.enumType(binding.enumInfo);
			case 'typeParam': return binding.type;
			case 'typeAlias': return binding.type;
			case 'native':
				if (binding.export.kind === 'class' && binding.export.classInfo) {
					return T.classType(binding.export.classInfo);
				}
				if (binding.export.kind === 'enum' && binding.export.enumInfo) {
					return T.enumType(binding.export.enumInfo);
				}
				this.error(`'${binding.name}' is not a type`, span);
				return T.unknown;
			default:
				this.error(`'${binding.name}' is not a type`, span);
				return T.unknown;
		}
	}

	// =====================================================================
	// Expression checking
	// =====================================================================

	checkExpr(expr: Expr, expected?: VType): VType {
		semaOf(expr).scope = this.scope;
		const type = this.checkExprInner(expr, expected);
		semaOf(expr).type = type;
		return type;
	}

	private checkExprInner(expr: Expr, expected?: VType): VType {
		const fn = this.currentFn();
		switch (expr.kind) {
			case 'IntLit': return T.int;
			case 'FloatLit': return T.float;
			case 'CharLit': return T.char;
			case 'LogicLit':
				// `false` doubles as the empty option literal.
				if (!expr.value && expected?.k === 'option') {
					semaOf(expr).type = expected;
					return expected;
				}
				return T.logic;
			case 'StringLit': {
				for (const part of expr.parts) {
					if (typeof part !== 'string') {
						this.checkExpr(part);
					}
				}
				return T.string;
			}
			case 'SelfExpr': {
				const cls = this.classStack[this.classStack.length - 1];
				if (!cls) {
					this.error("'Self' is only valid inside a class", expr.span);
					return T.unknown;
				}
				return T.classType(cls);
			}
			case 'Placeholder':
				return T.unknown;
			case 'Ident':
				return this.checkIdent(expr);
			case 'Block': {
				const blockScope = new Scope(this.scope, 'block');
				const previous = this.scope;
				this.scope = blockScope;
				let result: VType = T.void;
				for (let i = 0; i < expr.exprs.length; i++) {
					result = this.checkStatementInBody(expr.exprs[i], i === expr.exprs.length - 1 ? expected : undefined);
				}
				this.scope = previous;
				return result;
			}
			case 'Tuple': {
				const expectedElems = expected?.k === 'tuple' ? expected.elements : [];
				return T.tuple(expr.elements.map((e, i) => this.checkExpr(e, expectedElems[i])));
			}
			case 'ArrayLit': {
				const expectedElem = expected?.k === 'array' ? expected.element : undefined;
				let element: VType = expectedElem ?? T.unknown;
				for (const item of expr.elements) {
					const itemType = this.checkExpr(item, expectedElem);
					element = element.k === 'unknown' ? itemType : joinTypes(element, itemType);
				}
				return T.array(expr.elements.length === 0 ? (expectedElem ?? T.unknown) : element);
			}
			case 'MapLit': {
				const expectedKey = expected?.k === 'map' ? expected.key : undefined;
				const expectedValue = expected?.k === 'map' ? expected.value : undefined;
				let key: VType = expectedKey ?? T.unknown;
				let value: VType = expectedValue ?? T.unknown;
				for (const entry of expr.entries) {
					const keyType = this.checkExpr(entry.key, expectedKey);
					const valueType = this.checkExpr(entry.value, expectedValue);
					key = key.k === 'unknown' ? keyType : joinTypes(key, keyType);
					value = value.k === 'unknown' ? valueType : joinTypes(value, valueType);
				}
				return T.map(key, value, expected?.k === 'map' ? expected.weak : false);
			}
			case 'OptionLit': {
				if (!expr.value) {
					return expected?.k === 'option' ? expected : T.option(T.unknown);
				}
				// option{e} is a failure context: e may fail.
				const innerType = this.inFailureContext(() =>
					this.checkExpr(expr.value as Expr, expected?.k === 'option' ? expected.inner : undefined));
				return T.option(innerType);
			}
			case 'RangeExpr': {
				const low = this.checkExpr(expr.low);
				const high = this.checkExpr(expr.high);
				this.requireType(low, T.int, expr.low.span, 'Range bounds');
				this.requireType(high, T.int, expr.high.span, 'Range bounds');
				return T.array(T.int);
			}
			case 'TypeLit':
				return T.type;
			case 'Unary': {
				const operand = this.checkExpr(expr.operand, expected);
				if (operand.k === 'int' || operand.k === 'float' || operand.k === 'rational' || operand.k === 'unknown') {
					return operand;
				}
				this.error(`Unary '${expr.op}' requires a numeric operand, got ${typeToString(operand)}`, expr.span);
				return T.unknown;
			}
			case 'Binary':
				return this.checkBinary(expr);
			case 'AndExpr': {
				this.requireFailureContext(expr.span);
				const depth = fn ? fn.failureDepth : 0;
				void depth;
				this.checkExpr(expr.left);
				return this.checkExpr(expr.right);
			}
			case 'OrExpr': {
				// Left side runs speculatively; both sides must produce a value.
				const left = this.inFailureContext(() => this.checkExpr(expr.left));
				const right = this.checkExpr(expr.right);
				return joinTypes(left, right);
			}
			case 'NotExpr': {
				this.requireFailureContext(expr.span);
				this.inFailureContext(() => this.checkExpr(expr.operand));
				return T.void;
			}
			case 'QueryExpr': {
				this.requireFailureContext(expr.span);
				const operand = this.checkExpr(expr.operand);
				if (operand.k === 'option') {
					return operand.inner;
				}
				if (operand.k === 'logic' || operand.k === 'unknown') {
					return T.void;
				}
				this.error(`'?' requires an option or logic value, got ${typeToString(operand)}`, expr.span);
				return T.unknown;
			}
			case 'Call':
				return this.checkCall(expr, expected);
			case 'Index': {
				// Only produced for explicit `[]` types in expressions.
				this.checkExpr(expr.target);
				this.checkExpr(expr.index);
				return T.unknown;
			}
			case 'Member':
				return this.checkMember(expr);
			case 'Archetype':
				return this.checkArchetype(expr, expected);
			case 'Definition':
			case 'VarDefinition':
				return this.checkLocalDefinition(expr);
			case 'Assignment': {
				// Local binding in expression position (if conditions, bodies).
				const valueType = this.checkExpr(expr.value);
				const slot = this.scope.allocSlot();
				semaOf(expr).slot = slot;
				const ok = this.scope.define(expr.name, {
					kind: 'local', name: expr.name, slot, frameDepth: 0, mutable: false, type: valueType,
					frame: this.scope.owningFrame(), declSpan: expr.span,
				});
				if (!ok) {
					this.error(`'${expr.name}' is already defined in this scope`, expr.span, 'duplicate');
				}
				semaOf(expr).binding = this.scope.lookup(expr.name) ?? undefined;
				return valueType;
			}
			case 'SetExpr':
				return this.checkSet(expr);
			case 'FunctionDef': {
				// Nested function definition: bind as local function value.
				const slot = this.scope.allocSlot();
				semaOf(expr).slot = slot;
				const fnType = this.resolveFunctionType(expr);
				this.scope.define(expr.name, {
					kind: 'local', name: expr.name, slot, frameDepth: 0, mutable: false, type: fnType,
					frame: this.scope.owningFrame(), declSpan: expr.span,
				});
				this.checkFunctionDef(expr, null);
				return T.void;
			}
			case 'ClassDef':
			case 'ModuleDef':
			case 'EnumDef':
			case 'TypeAliasDef':
				this.error('Type definitions are only allowed at module scope', expr.span);
				return T.void;
			case 'UsingDecl':
				this.applyUsing(expr.path, expr.span);
				return T.void;
			case 'IfExpr':
				return this.checkIf(expr, expected);
			case 'CaseExpr':
				return this.checkCase(expr, expected);
			case 'ForExpr':
				return this.checkFor(expr);
			case 'LoopExpr': {
				if (fn) {
					fn.loopDepth += 1;
				}
				this.checkExpr(expr.body);
				if (fn) {
					fn.loopDepth -= 1;
				}
				return T.void;
			}
			case 'WhileExpr': {
				if (fn) {
					fn.loopDepth += 1;
				}
				this.inFailureContext(() => this.checkExpr(expr.condition));
				this.checkExpr(expr.body);
				if (fn) {
					fn.loopDepth -= 1;
				}
				return T.void;
			}
			case 'BreakExpr': {
				if (!fn || fn.loopDepth === 0) {
					this.error("'break' is only valid inside a loop", expr.span);
				}
				return T.never;
			}
			case 'ReturnExpr': {
				const valueType = expr.value ? this.checkExpr(expr.value, fn?.returnType) : T.void;
				if (
					fn && fn.returnType.k !== 'unknown' && fn.returnType.k !== 'void' &&
					!isSubtype(valueType, fn.returnType)
				) {
					this.error(
						`Cannot return ${typeToString(valueType)} from '${fn.name}' which returns ${typeToString(fn.returnType)}`,
						expr.span, 'return-type',
					);
				}
				return T.never;
			}
			case 'DeferExpr':
				this.checkExpr(expr.body);
				return T.void;
			case 'SpawnExpr': {
				// spawn is legal in immediate contexts; body must suspend.
				this.withSuspendsBudget(() => this.checkExpr(expr.body));
				return this.resolveNamedType('task', expr.span, this.scope);
			}
			case 'ConcurrencyBlock': {
				this.requireSuspends(expr.span, expr.op);
				let result: VType = T.unknown;
				for (const clause of expr.clauses) {
					result = this.checkExpr(clause);
				}
				if (expr.op === 'sync') {
					return T.tuple(expr.clauses.map(() => T.unknown));
				}
				if (expr.op === 'branch') {
					return T.void;
				}
				return result;
			}
			case 'OptionType':
			case 'ArrayType':
			case 'MapType':
			case 'TupleType':
			case 'FunctionType':
			case 'GenericType': {
				const resolved = this.resolveTypeExpr(expr);
				return T.typeValue(resolved);
			}
			case 'FailureExpr':
				this.error(`'${expr.keyword}' is reserved for future use and is not yet supported`, expr.span, 'reserved-future');
				return T.unknown;
			case 'ProfileExpr': {
				if (expr.label) {
					this.checkExpr(expr.label);
				}
				return this.checkExpr(expr.body, expected);
			}
			case 'Interpolant':
				return this.checkExpr(expr.expr);
		}
	}

	private checkStatementInBody(stmt: Expr, expected?: VType): VType {
		return this.checkExpr(stmt, expected);
	}

	private checkIdent(expr: import('../frontend/ast').Ident): VType {
		if (expr.name === 'super') {
			const cls = this.classStack[this.classStack.length - 1];
			if (!cls || cls.supers.length === 0) {
				this.error("'(super:)' requires a class with a superclass", expr.span);
				return T.unknown;
			}
			semaOf(expr).memberMode = 'super';
			return T.classType(cls.supers[0]);
		}
		const binding = this.scope.lookup(expr.name);
		if (!binding) {
			// Primitive type names used as values (cast targets, type args).
			const primitive = this.tryPrimitiveTypeName(expr.name);
			if (primitive) {
				return T.typeValue(primitive);
			}
			this.error(`Unknown identifier '${expr.name}'`, expr.span, 'unknown-identifier');
			return T.unknown;
		}
		semaOf(expr).binding = binding;
		if (binding.kind === 'local' && binding.frame) {
			semaOf(expr).frameDepth = this.scope.frameDepthTo(binding.frame);
			semaOf(expr).slot = binding.slot;
		}
		switch (binding.kind) {
			case 'local': return binding.type;
			case 'global': return binding.type;
			case 'function': {
				const overloads = binding.overloads;
				return overloads.length === 1 ? overloads[0].type : T.unknown;
			}
			case 'member': return binding.type;
			case 'class': return T.typeValue(T.classType(binding.classInfo));
			case 'enum': return T.typeValue(T.enumType(binding.enumInfo));
			case 'module': return T.unknown;
			case 'native': {
				const exp = binding.export;
				if (exp.kind === 'function' && exp.signatures && exp.signatures.length >= 1) {
					return exp.signatures.length === 1 ? exp.signatures[0] : T.unknown;
				}
				if (exp.kind === 'class' && exp.classInfo) {
					return T.typeValue(T.classType(exp.classInfo));
				}
				if (exp.kind === 'enum' && exp.enumInfo) {
					return T.typeValue(T.enumType(exp.enumInfo));
				}
				return exp.valueType ?? T.unknown;
			}
			case 'typeParam': return T.typeValue(binding.type);
			case 'typeAlias': return T.typeValue(binding.type);
		}
	}

	private checkBinary(expr: Extract<Expr, { kind: 'Binary' }>): VType {
		const left = this.checkExpr(expr.left);
		const right = this.checkExpr(expr.right);
		const isComparisonOp = ['=', '<>', '<', '<=', '>', '>='].includes(expr.op);
		if (isComparisonOp) {
			this.requireFailureContext(expr.span);
			return left.k === 'unknown' ? right : left;
		}
		// Arithmetic.
		const numeric = (t: VType) => t.k === 'int' || t.k === 'float' || t.k === 'rational' || t.k === 'unknown';
		if (expr.op === '+') {
			if (left.k === 'string' || right.k === 'string') {
				return T.string;
			}
			if (left.k === 'array' && right.k === 'array') {
				return T.array(joinTypes(left.element, right.element));
			}
			if (left.k === 'map' && right.k === 'map') {
				return T.map(joinTypes(left.key, right.key), joinTypes(left.value, right.value));
			}
		}
		if (!numeric(left) || !numeric(right)) {
			if (left.k !== 'unknown' && right.k !== 'unknown') {
				this.error(
					`Operator '${expr.op}' cannot combine ${typeToString(left)} and ${typeToString(right)}`,
					expr.span, 'bad-operands',
				);
			}
			return T.unknown;
		}
		if (left.k === 'float' || right.k === 'float') {
			if (left.k !== 'float' || right.k !== 'float') {
				this.error(
					`'${expr.op}' cannot mix float and non-float operands; convert explicitly (e.g. with ToFloat or Int[])`,
					expr.span, 'mixed-arithmetic',
				);
			}
			return T.float;
		}
		if (expr.op === '/') {
			// int / int is rational and failable (division by zero).
			if (left.k === 'int' && right.k === 'int') {
				this.requireFailureContext(expr.span);
				return T.rational;
			}
			this.requireFailureContext(expr.span);
			return left.k === 'rational' || right.k === 'rational' ? T.rational : T.unknown;
		}
		if (left.k === 'rational' || right.k === 'rational') {
			return T.rational;
		}
		return left.k === 'unknown' ? right : left;
	}

	private checkCall(expr: Call, expected?: VType): VType {
		void expected;
		const fnContext = this.currentFn();

		// Failable bracket form: cast, index, or failable call.
		if (expr.failable) {
			this.requireFailureContext(expr.span);
		}

		// Special: callee is a class/type -> cast (t[x]) or constructor misuse.
		const calleeType = this.checkExpr(expr.callee);
		const args = expr.args.map((a) => ({ name: a.name, type: this.checkExpr(a.value) }));

		if (calleeType.k === 'typeValue') {
			if (expr.failable) {
				semaOf(expr).callMode = 'cast';
				return calleeType.of;
			}
			// Generic type application in expression position: event(int){...}
			if (calleeType.of.k === 'class') {
				semaOf(expr).callMode = 'construct';
				const typeArgs = args.map((a) => (a.type.k === 'typeValue' ? a.type.of : T.unknown));
				return T.typeValue(T.classType(calleeType.of.info, typeArgs));
			}
			this.error('Types are instantiated with archetype syntax (name{...}) or cast with name[value]', expr.span);
			return T.unknown;
		}

		if (calleeType.k === 'array' || calleeType.k === 'string') {
			semaOf(expr).callMode = 'index';
			if (args.length !== 1) {
				this.error('Array indexing takes exactly one index', expr.span);
			}
			return calleeType.k === 'array' ? calleeType.element : T.char;
		}
		if (calleeType.k === 'map') {
			semaOf(expr).callMode = 'index';
			if (args.length !== 1) {
				this.error('Map lookup takes exactly one key', expr.span);
			}
			return calleeType.value;
		}
		if (calleeType.k === 'tuple') {
			semaOf(expr).callMode = 'index';
			const arg = expr.args[0]?.value;
			if (arg && arg.kind === 'IntLit' && arg.value >= 0 && arg.value < calleeType.elements.length) {
				return calleeType.elements[arg.value];
			}
			return T.unknown;
		}

		semaOf(expr).callMode = 'invoke';

		// Resolve overloads when the callee is a known function binding.
		const overloadTypes = this.calleeOverloads(expr.callee);
		if (overloadTypes && overloadTypes.length > 0) {
			const chosen = this.resolveOverload(overloadTypes, args, expr.span);
			if (chosen) {
				this.recordChosenOverloadSlot(expr.callee, chosen);
				this.applyCallEffects(chosen.effects, expr.span, expr.failable);
				return this.instantiateReturn(chosen, args);
			}
			return T.unknown;
		}

		if (calleeType.k === 'func') {
			this.applyCallEffects(calleeType.effects, expr.span, expr.failable);
			if (calleeType.params.filter((p) => !p.named && !p.hasDefault).length > args.length) {
				this.error(`Too few arguments to function`, expr.span, 'arity');
			}
			return this.instantiateReturn(calleeType, args);
		}

		if (calleeType.k !== 'unknown') {
			this.error(`Cannot call a value of type ${typeToString(calleeType)}`, expr.span, 'not-callable');
		}
		void fnContext;
		return T.unknown;
	}

	/** Records which overload's global slot a call site should load. */
	private recordChosenOverloadSlot(callee: Expr, chosen: FuncT): void {
		if (callee.kind !== 'Ident') {
			return;
		}
		const binding = this.scope.lookup(callee.name);
		if (binding?.kind === 'function') {
			const entry = binding.overloads.find((o) => o.type === chosen);
			if (entry) {
				semaOf(callee).slot = entry.slot;
			}
		}
	}

	private calleeOverloads(callee: Expr): FuncT[] | null {
		if (callee.kind === 'Ident') {
			const binding = this.scope.lookup(callee.name);
			if (binding?.kind === 'function') {
				return binding.overloads.map((o) => o.type);
			}
			if (binding?.kind === 'native' && binding.export.kind === 'function') {
				return binding.export.signatures ?? null;
			}
			if (binding?.kind === 'member' && binding.isMethod) {
				const member = this.lookupMember(binding.classInfo, binding.name);
				if (member?.overloads) {
					return member.overloads;
				}
				if (member && member.type.k === 'func') {
					return [member.type];
				}
			}
		}
		if (callee.kind === 'Member') {
			const sema = semaOf(callee);
			if (sema.memberBinding?.kind === 'function') {
				return sema.memberBinding.overloads.map((o) => o.type);
			}
			if (sema.memberBinding?.kind === 'native' && sema.memberBinding.export.kind === 'function') {
				return sema.memberBinding.export.signatures ?? null;
			}
			const targetType = semaOf(callee.target).type;
			if (targetType?.k === 'class') {
				const member = this.lookupMember(targetType.info, callee.name);
				if (member?.overloads && member.overloads.length > 0) {
					return member.overloads;
				}
				if (member && member.type.k === 'func') {
					return [member.type];
				}
			}
		}
		return null;
	}

	private resolveOverload(
		overloads: FuncT[],
		args: { name: string | null; type: VType }[],
		span: Span,
	): FuncT | null {
		const positional = args.filter((a) => a.name === null);
		const candidates = overloads.filter((o) => {
			const required = o.params.filter((p) => !p.named && !p.hasDefault).length;
			const maxPositional = o.params.filter((p) => !p.named).length;
			return positional.length >= required && positional.length <= Math.max(maxPositional, required);
		});
		if (candidates.length === 0) {
			this.error('No overload matches this argument count', span, 'arity');
			return null;
		}
		if (candidates.length === 1) {
			this.checkArgTypes(candidates[0], args, span);
			return candidates[0];
		}
		// Pick the most specific candidate whose parameters accept the
		// arguments (specificity: how many params are no wider than the arg).
		let best: FuncT | null = null;
		let bestScore = -1;
		for (const candidate of candidates) {
			if (!this.argsMatch(candidate, args)) {
				continue;
			}
			let score = 0;
			const positionalParams = candidate.params.filter((p) => !p.named);
			let index = 0;
			for (const arg of args) {
				if (arg.name !== null) {
					continue;
				}
				const param = positionalParams[index++];
				if (param && isSubtype(param.type, arg.type)) {
					score++;
				}
			}
			if (score > bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		if (best) {
			return best;
		}
		this.error('No overload matches these argument types', span, 'overload');
		return null;
	}

	private argsMatch(fn: FuncT, args: { name: string | null; type: VType }[]): boolean {
		const positionalParams = fn.params.filter((p) => !p.named);
		let index = 0;
		for (const arg of args) {
			if (arg.name !== null) {
				const named = fn.params.find((p) => p.named && p.name === arg.name);
				if (!named || !isSubtype(arg.type, named.type)) {
					return false;
				}
				continue;
			}
			const param = positionalParams[index++];
			if (!param) {
				return false;
			}
			if (!isSubtype(arg.type, param.type)) {
				return false;
			}
		}
		return true;
	}

	private checkArgTypes(fn: FuncT, args: { name: string | null; type: VType }[], span: Span): void {
		const positionalParams = fn.params.filter((p) => !p.named);

		// Whole-tuple application: F(GetTuple()) matching multiple params.
		if (
			args.length === 1 && args[0].name === null && args[0].type.k === 'tuple' &&
			positionalParams.length === args[0].type.elements.length && positionalParams.length > 1
		) {
			return;
		}

		let index = 0;
		const sub: Substitution = new Map();
		for (const arg of args) {
			if (arg.name !== null) {
				const named = fn.params.find((p) => p.named && p.name === arg.name);
				if (!named) {
					this.error(`Unknown named argument '?${arg.name}'`, span, 'named-arg');
				} else if (!unify(named.type, arg.type, sub)) {
					this.error(
						`Named argument '?${arg.name}' expects ${typeToString(named.type)}, got ${typeToString(arg.type)}`,
						span, 'arg-type',
					);
				}
				continue;
			}
			const param = positionalParams[index++];
			if (!param) {
				this.error('Too many arguments', span, 'arity');
				break;
			}
			if (!unify(param.type, arg.type, sub)) {
				this.error(
					`Argument ${index} expects ${typeToString(param.type)}, got ${typeToString(arg.type)}`,
					span, 'arg-type',
				);
			}
		}
	}

	private instantiateReturn(fn: FuncT, args: { name: string | null; type: VType }[]): VType {
		if (fn.typeParams.length === 0) {
			return fn.ret;
		}
		const sub: Substitution = new Map();
		const positionalParams = fn.params.filter((p) => !p.named);
		let index = 0;
		for (const arg of args) {
			if (arg.name !== null) {
				const named = fn.params.find((p) => p.named && p.name === arg.name);
				if (named) {
					unify(named.type, arg.type, sub);
				}
				continue;
			}
			const param = positionalParams[index++];
			if (param) {
				unify(param.type, arg.type, sub);
			}
		}
		return substitute(fn.ret, sub);
	}

	private applyCallEffects(effects: EffectSet, span: Span, failable: boolean): void {
		const fn = this.currentFn();
		if (!fn) {
			return;
		}
		fn.inferred = unionEffects(fn.inferred, effects);
		if (effects.suspends && !fn.declaredEffects.suspends) {
			this.error(
				"This function suspends; the caller must be marked '<suspends>'",
				span, 'suspends',
			);
		}
		if (effects.suspends && fn.failureDepth > 0 && !fn.declaredEffects.decides) {
			this.error(
				'Suspending calls are not allowed inside a failure context',
				span, 'suspends-in-failure',
			);
		}
		if (effects.decides) {
			if (!failable) {
				this.error(
					"This function can fail; call it with '[...]' instead of '(...)'",
					span, 'decides-brackets',
				);
			}
			this.requireFailureContext(span);
		}
		if (effects.writes && !fn.declaredEffects.writes) {
			this.error(
				`A '<computes>' or read-only function cannot call a function that writes state`,
				span, 'computes-writes',
			);
		}
	}

	private checkMember(expr: Extract<Expr, { kind: 'Member' }>): VType {
		// Module member: utils.Helper
		if (expr.target.kind === 'Ident') {
			const binding = this.scope.lookup(expr.target.name);
			if (binding?.kind === 'module') {
				const memberBinding = binding.module.scope.lookup(expr.name);
				if (!memberBinding) {
					this.error(`Module '${binding.name}' has no member '${expr.name}'`, expr.span, 'unknown-member');
					return T.unknown;
				}
				semaOf(expr).memberMode = 'binding';
				semaOf(expr).memberBinding = memberBinding;
				semaOf(expr.target).binding = binding;
				return this.bindingResultType(memberBinding);
			}
			if (binding?.kind === 'enum') {
				if (!binding.enumInfo.values.includes(expr.name)) {
					this.error(`Enum '${binding.name}' has no value '${expr.name}'`, expr.span, 'unknown-member');
					return T.unknown;
				}
				semaOf(expr).memberMode = 'enumValue';
				semaOf(expr).enumInfo = binding.enumInfo;
				semaOf(expr).enumValueName = expr.name;
				return T.enumType(binding.enumInfo);
			}
			if (binding?.kind === 'native' && binding.export.kind === 'enum' && binding.export.enumInfo) {
				const enumInfo = binding.export.enumInfo;
				if (!enumInfo.values.includes(expr.name)) {
					this.error(`Enum '${binding.name}' has no value '${expr.name}'`, expr.span, 'unknown-member');
					return T.unknown;
				}
				semaOf(expr).memberMode = 'enumValue';
				semaOf(expr).enumInfo = enumInfo;
				semaOf(expr).enumValueName = expr.name;
				return T.enumType(enumInfo);
			}
			if (expr.target.name === 'super') {
				this.checkExpr(expr.target);
				semaOf(expr).memberMode = 'super';
				const cls = this.classStack[this.classStack.length - 1];
				const superInfo = cls?.supers[0];
				if (superInfo) {
					const member = this.lookupMember(superInfo, expr.name);
					if (member) {
						semaOf(expr).memberInfo = member;
						return member.type;
					}
					this.error(`Superclass '${superInfo.name}' has no member '${expr.name}'`, expr.span, 'unknown-member');
				}
				return T.unknown;
			}
		}

		const targetType = this.checkExpr(expr.target);
		semaOf(expr).memberMode = 'dynamic';

		if (targetType.k === 'class') {
			// Substitute class type args into member types for parametrics.
			const member = this.lookupMember(targetType.info, expr.name);
			if (member) {
				semaOf(expr).memberInfo = member;
				if (member.access === 'private' && this.classStack[this.classStack.length - 1] !== member.origin) {
					this.error(`'${expr.name}' is private to ${member.origin.name}`, expr.span, 'access');
				}
				if (targetType.info.typeParams.length > 0 && targetType.typeArgs.length > 0) {
					const sub: Substitution = new Map();
					targetType.info.typeParams.forEach((tp, i) => {
						if (targetType.typeArgs[i]) {
							sub.set(tp.id, targetType.typeArgs[i]);
						}
					});
					return substitute(member.type, sub);
				}
				return member.type;
			}
			const builtin = this.builtinMemberType(targetType, expr.name);
			if (builtin) {
				return builtin;
			}
			const extension = this.lookupExtension(expr.name, targetType);
			if (extension) {
				semaOf(expr).memberMode = 'extension';
				semaOf(expr).extensionSlot = extension.slot;
				return extension.type;
			}
			this.error(`'${targetType.info.name}' has no member '${expr.name}'`, expr.span, 'unknown-member');
			return T.unknown;
		}

		const builtin = this.builtinMemberType(targetType, expr.name);
		if (builtin) {
			return builtin;
		}
		const extension = this.lookupExtension(expr.name, targetType);
		if (extension) {
			semaOf(expr).memberMode = 'extension';
			semaOf(expr).extensionSlot = extension.slot;
			return extension.type;
		}
		if (targetType.k !== 'unknown' && targetType.k !== 'any') {
			this.error(`${typeToString(targetType)} has no member '${expr.name}'`, expr.span, 'unknown-member');
		}
		return T.unknown;
	}

	private lookupExtension(name: string, target: VType): { type: FuncT; slot: number } | null {
		const list = this.extensions.get(name);
		if (!list) {
			return null;
		}
		for (const entry of list) {
			if (target.k === 'unknown' || isSubtype(target, entry.target)) {
				return entry;
			}
		}
		return null;
	}

	private builtinMemberType(target: VType, name: string): VType | null {
		if (target.k === 'array' || target.k === 'string') {
			const element = target.k === 'array' ? target.element : T.char;
			if (name === 'Length') {
				return T.int;
			}
			if (name === 'Slice') {
				const fn = T.func([T.int, T.int], target.k === 'array' ? target : T.string);
				fn.effects.decides = true;
				return fn;
			}
			if (name === 'Find') {
				const fn = T.func([element], T.int);
				fn.effects.decides = true;
				return fn;
			}
			return null;
		}
		if (target.k === 'map') {
			if (name === 'Length') {
				return T.int;
			}
			return null;
		}
		if (target.k === 'tuple') {
			return null;
		}
		if (target.k === 'class' && target.info.native) {
			// Native class members (task/event/...) resolved from the info.
			const member = this.lookupMember(target.info, name);
			return member ? member.type : null;
		}
		return null;
	}

	private bindingResultType(binding: Binding): VType {
		switch (binding.kind) {
			case 'local': case 'global': case 'member': return binding.type;
			case 'function':
				return binding.overloads.length === 1 ? binding.overloads[0].type : T.unknown;
			case 'class': return T.typeValue(T.classType(binding.classInfo));
			case 'enum': return T.typeValue(T.enumType(binding.enumInfo));
			case 'native': {
				const exp = binding.export;
				if (exp.kind === 'function' && exp.signatures?.length === 1) {
					return exp.signatures[0];
				}
				if (exp.kind === 'class' && exp.classInfo) {
					return T.typeValue(T.classType(exp.classInfo));
				}
				return exp.valueType ?? T.unknown;
			}
			default:
				return T.unknown;
		}
	}

	private checkArchetype(expr: Archetype, expected?: VType): VType {
		void expected;
		const calleeType = this.checkExpr(expr.callee);
		let classInfo: ClassInfo | null = null;
		let typeArgs: VType[] = [];
		if (calleeType.k === 'typeValue' && calleeType.of.k === 'class') {
			classInfo = calleeType.of.info;
			typeArgs = calleeType.of.typeArgs;
		}
		if (!classInfo) {
			if (calleeType.k !== 'unknown') {
				this.error('Archetype instantiation requires a class or struct', expr.span, 'not-a-class');
			}
			for (const field of expr.fields) {
				this.checkExpr(field.value);
			}
			return T.unknown;
		}
		if (classInfo.abstract) {
			this.error(`Cannot instantiate abstract ${classInfo.kind} '${classInfo.name}'`, expr.span, 'abstract');
		}
		if (classInfo.kind === 'interface') {
			this.error(`Cannot instantiate interface '${classInfo.name}'`, expr.span, 'abstract');
		}

		const sub: Substitution = new Map();
		classInfo.typeParams.forEach((tp, i) => {
			if (typeArgs[i]) {
				sub.set(tp.id, typeArgs[i]);
			}
		});

		const assigned = new Set<string>();
		for (const field of expr.fields) {
			const member = this.lookupMember(classInfo, field.name);
			if (!member) {
				this.error(`'${classInfo.name}' has no field '${field.name}'`, field.span, 'unknown-member');
				this.checkExpr(field.value);
				continue;
			}
			assigned.add(field.name);
			const expectedField = substitute(member.type, sub);
			const valueType = this.checkExpr(field.value, expectedField);
			if (expectedField.k !== 'unknown' && !isSubtype(valueType, expectedField)) {
				this.error(
					`Field '${field.name}' expects ${typeToString(expectedField)}, got ${typeToString(valueType)}`,
					field.span, 'type-mismatch',
				);
			}
		}
		// All fields without defaults must be assigned.
		const requireFields = (ci: ClassInfo) => {
			for (const [name, member] of ci.members) {
				if (!member.isMethod && !member.hasBody && !assigned.has(name)) {
					this.error(
						`Field '${name}' of '${ci.name}' has no default and must be initialized`,
						expr.span, 'missing-field',
					);
				}
			}
			for (const parent of ci.supers) {
				requireFields(parent);
			}
		};
		requireFields(classInfo);

		return T.classType(classInfo, typeArgs);
	}

	private checkLocalDefinition(stmt: Definition | VarDefinition): VType {
		const declared = stmt.type ? this.resolveTypeExpr(stmt.type) : null;
		let valueType: VType = T.unknown;
		if (stmt.value) {
			valueType = this.checkExpr(stmt.value, declared ?? undefined);
			if (declared && !isSubtype(valueType, declared)) {
				this.error(
					`Cannot initialize '${stmt.name}' of type ${typeToString(declared)} with ${typeToString(valueType)}`,
					stmt.span, 'type-mismatch',
				);
			}
		} else if (!declared) {
			this.error(`'${stmt.name}' needs a type or a value`, stmt.span);
		} else if (stmt.kind === 'VarDefinition') {
			this.error(`'var ${stmt.name}' needs an initial value`, stmt.span);
		}

		if (stmt.kind === 'VarDefinition') {
			const fn = this.currentFn();
			if (fn && !fn.declaredEffects.writes && !fn.declaredEffects.allocates) {
				this.error("A '<computes>' function cannot declare mutable state", stmt.span, 'computes-writes');
			}
		}

		const slot = this.scope.allocSlot();
		semaOf(stmt).slot = slot;
		const ok = this.scope.define(stmt.name, {
			kind: 'local',
			name: stmt.name,
			slot,
			frameDepth: 0,
			mutable: stmt.kind === 'VarDefinition',
			type: declared ?? valueType,
			frame: this.scope.owningFrame(),
			declSpan: stmt.span,
		});
		if (!ok) {
			this.error(`'${stmt.name}' is already defined in this scope`, stmt.span, 'duplicate');
		}
		return T.void;
	}

	private checkSet(stmt: SetExpr): VType {
		const fn = this.currentFn();
		if (fn) {
			fn.inferred.writes = true;
			if (!fn.declaredEffects.writes) {
				this.error("Assignment requires the 'writes' effect (default '<transacts>')", stmt.span, 'computes-writes');
			}
		}

		const target = stmt.target;
		let targetType: VType = T.unknown;
		if (target.kind === 'Ident') {
			const binding = this.scope.lookup(target.name);
			if (!binding) {
				this.error(`Unknown identifier '${target.name}'`, target.span, 'unknown-identifier');
			} else {
				semaOf(target).binding = binding;
				if (binding.kind === 'local' && binding.frame) {
					semaOf(target).frameDepth = this.scope.frameDepthTo(binding.frame);
					semaOf(target).slot = binding.slot;
				}
				if (binding.kind === 'local' || binding.kind === 'global') {
					if (!binding.mutable) {
						this.error(`'${target.name}' is not a 'var' and cannot be assigned`, stmt.span, 'not-mutable');
					}
					targetType = binding.type;
				} else if (binding.kind === 'member') {
					if (!binding.mutable) {
						this.error(`Field '${target.name}' is not a 'var' and cannot be assigned`, stmt.span, 'not-mutable');
					}
					targetType = binding.type;
				} else {
					this.error(`'${target.name}' cannot be assigned`, stmt.span, 'not-mutable');
				}
			}
		} else if (target.kind === 'Member') {
			targetType = this.checkExpr(target);
			const targetSema = semaOf(target.target).type;
			if (targetSema?.k === 'class') {
				const member = this.lookupMember(targetSema.info, target.name);
				if (member && !member.mutable) {
					this.error(`Field '${target.name}' is not a 'var' and cannot be assigned`, stmt.span, 'not-mutable');
				}
			}
		} else if (target.kind === 'Call' && target.failable) {
			// set Arr[i] = v / set Map[k] = v
			const containerType = this.checkExpr(target.callee);
			for (const arg of target.args) {
				this.checkExpr(arg.value);
			}
			if (containerType.k === 'array') {
				// Array element assignment can fail (index out of range).
				this.requireFailureContext(stmt.span);
				targetType = containerType.element;
			} else if (containerType.k === 'map') {
				targetType = containerType.value;
			} else {
				targetType = T.unknown;
			}
			semaOf(target).callMode = 'index';
		} else {
			this.error('Invalid assignment target', stmt.span, 'bad-set-target');
		}

		const valueType = this.checkExpr(stmt.value, targetType.k !== 'unknown' ? targetType : undefined);
		if (stmt.op === '=' && targetType.k !== 'unknown' && !isSubtype(valueType, targetType)) {
			this.error(
				`Cannot assign ${typeToString(valueType)} to ${typeToString(targetType)}`,
				stmt.span, 'type-mismatch',
			);
		}
		if (stmt.op !== '=') {
			const numericOrContainer = ['int', 'float', 'rational', 'string', 'array', 'map', 'unknown'];
			if (!numericOrContainer.includes(targetType.k)) {
				this.error(`'${stmt.op}' is not supported for ${typeToString(targetType)}`, stmt.span, 'bad-operands');
			}
		}
		return valueType;
	}

	private checkIf(expr: IfExpr, expected?: VType): VType {
		let result: VType | null = null;
		for (const clause of expr.clauses) {
			const clauseScope = new Scope(this.scope, 'block');
			const previous = this.scope;
			this.scope = clauseScope;
			this.inFailureContext(() => {
				for (const condition of clause.conditions) {
					this.checkExpr(condition);
				}
			});
			const bodyType = this.checkExpr(clause.body, expected);
			this.scope = previous;
			result = result === null ? bodyType : joinTypes(result, bodyType);
		}
		if (expr.elseBody) {
			const elseType = this.checkExpr(expr.elseBody, expected);
			result = result === null ? elseType : joinTypes(result, elseType);
		} else if (!this.inDecidesBody()) {
			// Without else the if produces void: the branch may not run.
			result = T.void;
		}
		// In a <decides> body a bare if propagates failure, so its value is
		// the then-branch value.
		return result ?? T.void;
	}

	/** True when the innermost function has the decides effect. */
	private inDecidesBody(): boolean {
		const fn = this.currentFn();
		return !!fn?.declaredEffects.decides;
	}

	private checkCase(expr: CaseExpr, expected?: VType): VType {
		const subjectType = this.checkExpr(expr.subject);
		let result: VType | null = null;
		let hasWildcard = false;
		for (const arm of expr.arms) {
			if (arm.pattern === null) {
				hasWildcard = true;
			} else {
				const patternType = this.checkExpr(arm.pattern);
				if (
					subjectType.k !== 'unknown' && patternType.k !== 'unknown' &&
					!isSubtype(patternType, subjectType) && !isSubtype(subjectType, patternType)
				) {
					this.error(
						`Case pattern of type ${typeToString(patternType)} cannot match subject of type ${typeToString(subjectType)}`,
						arm.pattern.span, 'case-pattern',
					);
				}
			}
			const armType = this.checkExpr(arm.body, expected);
			result = result === null ? armType : joinTypes(result, armType);
		}
		if (!hasWildcard && subjectType.k !== 'enum') {
			// Non-exhaustive case fails at runtime; Verse requires wildcard or
			// enum exhaustiveness. Report gently as a warning.
			this.warning("'case' without a '_' arm fails when no pattern matches", expr.span);
		}
		return result ?? T.void;
	}

	private checkFor(expr: ForExpr): VType {
		const fn = this.currentFn();
		const forScope = new Scope(this.scope, 'block');
		const previous = this.scope;
		this.scope = forScope;

		for (const generator of expr.generators) {
			const iterableType = this.inFailureContext(() => this.checkExpr(generator.iterable));
			let elemType: VType = T.unknown;
			let valueType: VType | null = null;
			if (iterableType.k === 'array') {
				elemType = iterableType.element;
			} else if (iterableType.k === 'string') {
				elemType = T.char;
			} else if (iterableType.k === 'map') {
				if (generator.valueName) {
					elemType = iterableType.key;
					valueType = iterableType.value;
				} else {
					elemType = iterableType.value;
				}
			} else if (iterableType.k === 'int') {
				// for (X := expr) binding form (single value, not iteration).
				elemType = iterableType;
			} else {
				elemType = T.unknown;
			}
			const slot = this.scope.allocSlot();
			(generator as ForGenerator & { sema?: SemaData }).sema = { slot };
			forScope.define(generator.name, {
				kind: 'local', name: generator.name, slot, frameDepth: 0, mutable: false, type: elemType,
				frame: this.scope.owningFrame(), declSpan: generator.span,
			});
			if (generator.valueName) {
				const valueSlot = this.scope.allocSlot();
				(generator as ForGenerator & { semaValue?: SemaData }).semaValue = { slot: valueSlot };
				forScope.define(generator.valueName, {
					kind: 'local', name: generator.valueName, slot: valueSlot, frameDepth: 0, mutable: false,
					type: valueType ?? T.unknown, frame: this.scope.owningFrame(), declSpan: generator.span,
				});
			}
		}
		this.inFailureContext(() => {
			for (const filter of expr.filters) {
				this.checkExpr(filter);
			}
		});

		if (fn) {
			fn.loopDepth += 1;
		}
		const bodyType = this.checkExpr(expr.body);
		if (fn) {
			fn.loopDepth -= 1;
		}
		this.scope = previous;
		return T.array(bodyType);
	}

	// =====================================================================
	// Failure / effect context helpers
	// =====================================================================

	private inFailureContext<TResult>(body: () => TResult): TResult {
		const fn = this.currentFn();
		if (fn) {
			fn.failureDepth += 1;
		}
		try {
			return body();
		} finally {
			if (fn) {
				fn.failureDepth -= 1;
			}
		}
	}

	private requireFailureContext(span: Span): void {
		const fn = this.currentFn();
		if (!fn || fn.failureDepth === 0) {
			this.error(
				'This expression can fail; it must occur in a failure context (an if condition, or inside a <decides> function)',
				span, 'failure-context',
			);
		} else {
			if (fn) {
				fn.inferred.decides = true;
			}
		}
	}

	private requireSuspends(span: Span, what: string): void {
		const fn = this.currentFn();
		if (!fn || !fn.declaredEffects.suspends) {
			this.error(
				`'${what}' requires an async context; mark the enclosing function '<suspends>'`,
				span, 'suspends',
			);
		}
		if (fn) {
			fn.inferred.suspends = true;
		}
	}

	private withSuspendsBudget<TResult>(body: () => TResult): TResult {
		const fn = this.currentFn();
		if (!fn) {
			return body();
		}
		const saved = fn.declaredEffects;
		fn.declaredEffects = { ...saved, suspends: true };
		try {
			return body();
		} finally {
			fn.declaredEffects = saved;
		}
	}

	private requireType(actual: VType, expectedType: VType, span: Span, what: string): void {
		if (actual.k !== 'unknown' && !isSubtype(actual, expectedType)) {
			this.error(`${what} must be ${typeToString(expectedType)}, got ${typeToString(actual)}`, span, 'type-mismatch');
		}
	}

	private tryPrimitiveTypeName(name: string): VType | null {
		switch (name) {
			case 'int': return T.int;
			case 'float': return T.float;
			case 'rational': return T.rational;
			case 'logic': return T.logic;
			case 'char': return T.char;
			case 'char32': return T.char32;
			case 'string': return T.string;
			case 'void': return T.void;
			case 'any': return T.any;
			case 'comparable': return T.comparable;
			default: return null;
		}
	}

	private accessFromSpecifiers(specifiers: Specifier[]): AccessLevel {
		for (const spec of specifiers) {
			if (spec.name === 'public' || spec.name === 'private' || spec.name === 'protected' || spec.name === 'internal') {
				return spec.name;
			}
		}
		return 'internal';
	}
}

export type { Attribute };
