// compile-closures.ts
// The execution back end: compiles the checked AST into a tree of JS
// closures. Closures return plain values on the synchronous fast path and
// only produce Promises at genuine suspension points (Sleep, Await,
// concurrency, debug pauses), so sequential Verse code runs without any
// per-statement async overhead.
//
// Failure semantics: failable expressions return the FAIL sentinel; failure
// contexts open a Transaction journal and roll back on FAIL. Debug mode
// additionally weaves per-statement hooks for breakpoints and stepping.

import {
	Archetype, Block, Call, CaseExpr, ClassDef, Definition, EnumDef, Expr,
	ForExpr, FunctionDef, IfExpr, Program, SetExpr, VarDefinition,
} from '../frontend/ast';
import { EntryClass, SemaData, semaOf, WorkspaceFile } from '../sema/checker';
import { Binding, NativeExport } from '../sema/scopes';
import { ClassInfo, VType } from '../sema/types';
import { Ctx } from './context';
import {
	BreakSignal, ReturnSignal, Transaction, VerseRuntimeError,
} from './failure';
import { NativeEntry, NativeRegistry } from '../bindings/registry';
import {
	asRational, canonicalKey, FAIL, isTask, Value, VEnumValue, VTask,
	verseEquals, verseFloatToString, verseToString, VFunctionValue, VMap,
	VNativeFunction, VObject, VOption, VRational, VStruct, VTuple, VTypeValue,
} from './values';

export type Code = (env: Env, ctx: Ctx) => unknown;

export interface Env {
	slots: Value[];
	parent: Env | null;
	self: Value;
	names?: (string | undefined)[];
}

const YIELD_EVERY_BACKEDGES = 100_000;

function isPromise(v: unknown): v is Promise<unknown> {
	return v instanceof Promise;
}

function chain(v: unknown, f: (value: unknown) => unknown): unknown {
	return isPromise(v) ? v.then(f) : f(v);
}

/** Runtime class object: also a first-class type value (cast target). */
export class RuntimeClass extends VTypeValue {
	info: ClassInfo;
	superClass: RuntimeClass | null = null;
	isStruct: boolean;
	/** Field initialization order including inherited fields. */
	fieldOrder: { name: string; init: Code | null; frameSize: number }[] = [];
	methods: Map<string, VFunctionValue> = new Map();
	blocks: { code: Code; frameSize: number }[] = [];

	constructor(info: ClassInfo) {
		super(info.name, null, (value: Value) => {
			if (value instanceof VObject && this.objectConforms(value)) {
				return value;
			}
			return FAIL;
		});
		this.info = info;
		this.isStruct = info.kind === 'struct';
	}

	conforms(name: string): boolean {
		const walk = (info: ClassInfo): boolean =>
			info.name === name || info.supers.some(walk);
		return walk(this.info);
	}

	objectConforms(value: VObject): boolean {
		const cls = value.cls as { info?: ClassInfo; conforms?: (n: string) => boolean };
		if (cls.info) {
			const walk = (info: ClassInfo): boolean => info === this.info || info.supers.some(walk);
			return walk(cls.info);
		}
		return cls.conforms ? cls.conforms(this.info.name) : false;
	}
}

/** Native class value (event, task, player, creative_device...). */
export class NativeClassValue extends VTypeValue {
	entry: Extract<NativeEntry, { kind: 'class' }>;

	constructor(entry: Extract<NativeEntry, { kind: 'class' }>) {
		super(entry.name, null, (value: Value) => {
			if (value instanceof VObject) {
				const cls = value.cls as { conforms?: (n: string) => boolean };
				if (cls.conforms?.(entry.name)) {
					return value;
				}
			}
			// Non-object engine values (tasks, events, ...) declare their own
			// runtime type test through the bindings API.
			if (entry.matches?.(value)) {
				return value;
			}
			return FAIL;
		});
		this.entry = entry;
	}
}

export interface CompiledProgram {
	/**
	 * Initializes classes/functions/globals from every file, then runs
	 * top-level statements and entry points. When `entry` is given, only
	 * that file's top-level statements and entry classes execute (other
	 * files act as libraries); otherwise every file runs in order.
	 */
	run(ctx: Ctx, entry?: string): Promise<void>;
	globalCount: number;
	/** The bindings the program was compiled against. */
	registry: NativeRegistry;
	/** Workspace file names this program was compiled from. */
	files: string[];
}

export interface CompileOptions {
	debug: boolean;
}

export function compileProgram(
	program: Program | WorkspaceFile[],
	registry: NativeRegistry,
	globalCount: number,
	entryClasses: EntryClass[],
	options: CompileOptions,
): CompiledProgram {
	const files: WorkspaceFile[] = Array.isArray(program)
		? program
		: [{ file: 'main.verse', program }];
	const compiler = new Compiler(registry, options);
	return compiler.compile(files, globalCount, entryClasses);
}

interface FnCompileCtx {
	/** decides functions: FAIL propagates out of statements. */
	failSoft: boolean;
	/** Current class for Self/super/member resolution. */
	runtimeClassOf: (info: ClassInfo) => RuntimeClass | null;
	currentClass: ClassInfo | null;
	names: (string | undefined)[] | null;
	/** Set while compiling a body that contains a `branch` block. */
	sawBranch: boolean;
}

class Compiler {
	registry: NativeRegistry;
	debug: boolean;
	private classMap: Map<ClassInfo, RuntimeClass> = new Map();
	private nativeValueCache: Map<NativeExport, Value> = new Map();
	private fnCtx: FnCompileCtx;
	/** Workspace file currently being compiled (stamped onto statements). */
	private currentFile = 'main.verse';

	constructor(registry: NativeRegistry, options: CompileOptions) {
		this.registry = registry;
		this.debug = options.debug;
		this.fnCtx = {
			failSoft: false,
			runtimeClassOf: (info) => this.classMap.get(info) ?? null,
			currentClass: null,
			names: null,
			sawBranch: false,
		};
	}

	compile(files: WorkspaceFile[], globalCount: number, entryClasses: EntryClass[]): CompiledProgram {
		// Collect declarations across all files and nested modules, in
		// file-then-source order, remembering each item's file.
		const classes: { file: string; def: ClassDef }[] = [];
		const enums: { file: string; def: EnumDef }[] = [];
		const functions: { file: string; def: FunctionDef }[] = [];
		const initializers: { file: string; def: Definition | VarDefinition }[] = [];
		const statements: { file: string; stmt: Expr }[] = [];

		const collect = (file: string, body: Expr[]) => {
			for (const stmt of body) {
				switch (stmt.kind) {
					case 'ClassDef': classes.push({ file, def: stmt }); break;
					case 'EnumDef': enums.push({ file, def: stmt }); break;
					case 'FunctionDef': functions.push({ file, def: stmt }); break;
					case 'Definition': case 'VarDefinition': initializers.push({ file, def: stmt }); break;
					case 'ModuleDef': collect(file, stmt.members); break;
					case 'UsingDecl': case 'TypeAliasDef': break;
					default: statements.push({ file, stmt }); break;
				}
			}
		};
		for (const { file, program } of files) {
			collect(file, program.body);
		}

		// Build runtime class shells, then finalize supers-first.
		for (const cls of classes) {
			this.currentFile = cls.file;
			this.buildRuntimeClass(cls.def);
		}
		this.finalizeAll(classes);

		// Compile functions and initializers.
		const compiledFns = functions.map(({ file, def: fn }) => {
			this.currentFile = file;
			return {
				slot: semaOf(fn).slot ?? -1,
				isExtension: !!semaOf(fn).isExtension,
				name: fn.name,
				make: this.compileFunction(fn, null),
			};
		});
		const compiledInits = initializers
			.filter(({ def }) => def.value !== null)
			.map(({ file, def: d }) => {
				this.currentFile = file;
				let code = this.compileExpr(d.value as Expr);
				if (this.debug) {
					const inner = code;
					const line = d.span.start.line;
					code = (env, ctx) => {
						ctx.line = line;
						ctx.file = file;
						const hook = ctx.shared.debug?.onStatement(line, file, ctx, env);
						return chain(hook, () => inner(env, ctx));
					};
				}
				return {
					slot: semaOf(d).slot ?? -1,
					name: d.name,
					frameSize: semaOf(d.value as Expr).frameSize ?? 0,
					code,
					isWeakMap: this.isPersistentWeakMap(d),
				};
			});
		const compiledStatements = statements.map(({ file, stmt }) => {
			this.currentFile = file;
			return {
				file,
				frameSize: semaOf(stmt).frameSize ?? 0,
				code: this.compileStatement(stmt, true),
			};
		});

		const enumValues = enums.map(({ def }) => ({ def, info: semaOf(def).enumInfo }));
		const classSlots = classes.map(({ def }) => ({
			slot: semaOf(def).slot ?? -1,
			rc: this.classMap.get(semaOf(def).classInfo as ClassInfo) as RuntimeClass,
		}));
		const entries = entryClasses
			.map((entry) => ({
				rc: this.classMap.get(semaOf(entry.def).classInfo as ClassInfo),
				method: entry.method,
				file: entry.file,
			}))
			.filter((entry): entry is { rc: RuntimeClass; method: string; file: string } => !!entry.rc);

		const run = async (ctx: Ctx, entry?: string): Promise<void> => {
			const globals = ctx.shared.globals;
			globals.length = globalCount;
			const rootEnv: Env = { slots: globals, parent: null, self: undefined };

			// 1. Classes, functions, enums (no user code runs).
			for (const { slot, rc } of classSlots) {
				if (slot >= 0) {
					globals[slot] = rc;
				}
			}
			for (const fn of compiledFns) {
				const fnValue = fn.make(rootEnv);
				if (fn.slot >= 0) {
					globals[fn.slot] = fnValue;
				}
				if (fn.isExtension) {
					const list = ctx.shared.extensionMethods;
					list.set(fn.name, fnValue);
				}
			}
			void enumValues;

			// 2. Global initializers from every file, in order (libraries
			// must be initialized even when only the entry file runs).
			for (const init of compiledInits) {
				const env: Env = { slots: new Array(init.frameSize), parent: rootEnv, self: undefined };
				let value = init.code(env, ctx);
				if (isPromise(value)) {
					value = await value;
				}
				if (value === FAIL) {
					throw new VerseRuntimeError(`Initializer for '${init.name}' failed`);
				}
				if (init.isWeakMap) {
					value = this.loadPersistentMap(ctx, init.name, value as Value);
				}
				if (init.slot >= 0) {
					// Structs have value semantics: copy on assignment so a
					// global initialized from another global doesn't alias it.
					globals[init.slot] = copyIfStruct(value as Value);
				}
			}

			// 3. Top-level statements (entry file only, when selected).
			for (const stmt of compiledStatements) {
				if (entry !== undefined && stmt.file !== entry) {
					continue;
				}
				const env: Env = { slots: new Array(stmt.frameSize), parent: rootEnv, self: undefined };
				const result = stmt.code(env, ctx);
				if (isPromise(result)) {
					await result;
				}
			}

			// 4. Entry points: instantiate each matching class, then run its
			// registered entry method (e.g. creative_device.OnBegin).
			for (const { rc, method, file } of entries) {
				if (entry !== undefined && file !== entry) {
					continue;
				}
				const instanceResult = this.instantiate(rc, new Map(), { slots: [], parent: rootEnv, self: undefined }, ctx);
				const instance = (isPromise(instanceResult) ? await instanceResult : instanceResult) as VObject;
				const entryMethod = rc.methods.get(method);
				if (entryMethod) {
					const resolved = resolveMethod(entryMethod, ctx);
					const result = (resolved.invoke as (self: Value, args: Value[], ctx: Ctx) => unknown)(instance, [], ctx);
					if (isPromise(result)) {
						await result;
					}
				}
			}
		};

		return { run, globalCount, registry: this.registry, files: files.map((f) => f.file) };
	}

	private isPersistentWeakMap(d: Definition | VarDefinition): boolean {
		const type = d.type;
		return !!type && type.kind === 'GenericType' &&
			type.base.kind === 'Ident' && type.base.name === 'weak_map';
	}

	private loadPersistentMap(ctx: Ctx, name: string, initial: Value): Value {
		const adapter = ctx.shared.persistence;
		const map = initial instanceof VMap ? initial : new VMap(true);
		map.weak = true;
		if (adapter) {
			const stored = adapter.load(`versemap:${name}`);
			if (stored) {
				try {
					const parsed = JSON.parse(stored) as [unknown, unknown][];
					for (const [key, value] of parsed) {
						map.set(reviveJson(key), reviveJson(value));
					}
				} catch {
					// Corrupt storage: start fresh.
				}
			}
			ctx.shared.persistenceKeys.set(name, `versemap:${name}`);
			(map as VMap & { persistName?: string }).persistName = name;
		}
		return map;
	}

	// =====================================================================
	// Classes
	// =====================================================================

	private buildRuntimeClass(cls: ClassDef): RuntimeClass {
		const info = semaOf(cls).classInfo as ClassInfo;
		const existing = this.classMap.get(info);
		if (existing) {
			return existing;
		}
		const rc = new RuntimeClass(info);
		this.classMap.set(info, rc);

		// Inherited pieces first (single class super; interfaces may carry
		// default method bodies).
		// Supers were resolved by the checker; runtime supers are built on
		// demand when their ClassDef is compiled later, so merge lazily at
		// first instantiation instead: here we rely on source order (supers
		// precede uses in the common case) and fall back to merging in
		// finalize().
		return rc;
	}

	private finalizeClass(cls: ClassDef): void {
		const info = semaOf(cls).classInfo as ClassInfo;
		const rc = this.classMap.get(info) as RuntimeClass;

		const superInfos = info.supers;
		for (const superInfo of superInfos) {
			const superRc = this.classMap.get(superInfo);
			if (superRc) {
				if (!rc.superClass && superInfo.kind === 'class') {
					rc.superClass = superRc;
				}
				// Merge inherited fields/methods (first wins later override).
				for (const field of superRc.fieldOrder) {
					if (!rc.fieldOrder.some((f) => f.name === field.name)) {
						rc.fieldOrder.push(field);
					}
				}
				for (const [name, method] of superRc.methods) {
					if (!rc.methods.has(name)) {
						rc.methods.set(name, method);
					}
				}
			}
		}

		const previousClass = this.fnCtx.currentClass;
		this.fnCtx.currentClass = info;

		for (const member of cls.members) {
			if (member.kind === 'FunctionDef') {
				if (member.body === null) {
					continue;
				}
				const make = this.compileFunction(member, info);
				// Methods capture the root env at run time; created lazily on
				// first instantiation via a placeholder that closes over make.
				const fnValue = new VFunctionValue(member.name, () => undefined);
				(fnValue as VFunctionValue & { __make?: (env: Env) => VFunctionValue }).__make = make;
				rc.methods.set(member.name, fnValue);
			} else if (member.kind === 'Definition' || member.kind === 'VarDefinition') {
				const init = member.value ? this.compileExpr(member.value) : null;
				const frameSize = member.value ? (semaOf(member.value).frameSize ?? 0) : 0;
				const existingIndex = rc.fieldOrder.findIndex((f) => f.name === member.name);
				const entry = { name: member.name, init, frameSize };
				if (existingIndex >= 0) {
					rc.fieldOrder[existingIndex] = entry;
				} else {
					rc.fieldOrder.push(entry);
				}
			}
		}
		for (const blockClause of cls.blocks) {
			rc.blocks.push({
				code: this.compileExpr(blockClause.kind === 'Block' ? blockClause.exprs[0] : blockClause),
				frameSize: semaOf(blockClause).frameSize ?? 0,
			});
		}

		this.fnCtx.currentClass = previousClass;
	}

	/** Compiles class bodies supers-first (source order may be arbitrary). */
	finalizeAll(classes: { file: string; def: ClassDef }[]): void {
		const byInfo = new Map<ClassInfo, { file: string; def: ClassDef }>();
		for (const cls of classes) {
			byInfo.set(semaOf(cls.def).classInfo as ClassInfo, cls);
		}
		const done = new Set<ClassDef>();
		const visit = (cls: { file: string; def: ClassDef }) => {
			if (done.has(cls.def)) {
				return;
			}
			done.add(cls.def);
			const info = semaOf(cls.def).classInfo as ClassInfo;
			for (const superInfo of info.supers) {
				const superDef = byInfo.get(superInfo);
				if (superDef) {
					visit(superDef);
				}
			}
			this.currentFile = cls.file;
			this.finalizeClass(cls.def);
		};
		for (const cls of classes) {
			visit(cls);
		}
	}

	instantiate(rc: RuntimeClass, provided: Map<string, unknown>, env: Env, ctx: Ctx): unknown {
		const fields = new Map<string, Value>();
		const obj = rc.isStruct ? new VStruct(rc, fields) : new VObject(rc, fields);

		const steps = rc.fieldOrder;
		const runStep = (index: number): unknown => {
			for (let i = index; i < steps.length; i++) {
				const step = steps[i];
				if (provided.has(step.name)) {
					fields.set(step.name, provided.get(step.name) as Value);
					continue;
				}
				if (!step.init) {
					throw new VerseRuntimeError(`Field '${step.name}' of '${rc.name}' was not initialized`);
				}
				const initEnv: Env = { slots: new Array(step.frameSize), parent: rootOf(env), self: obj };
				const r = step.init(initEnv, ctx);
				if (isPromise(r)) {
					return r.then((value) => {
						if (value === FAIL) {
							throw new VerseRuntimeError(`Field initializer for '${step.name}' failed`);
						}
						fields.set(step.name, value as Value);
						return runStep(i + 1);
					});
				}
				if (r === FAIL) {
					throw new VerseRuntimeError(`Field initializer for '${step.name}' failed`);
				}
				fields.set(step.name, r as Value);
			}
			return runBlocks(0);
		};
		const runBlocks = (index: number): unknown => {
			for (let i = index; i < rc.blocks.length; i++) {
				const blockClause = rc.blocks[i];
				const blockEnv: Env = { slots: new Array(blockClause.frameSize), parent: rootOf(env), self: obj };
				const r = blockClause.code(blockEnv, ctx);
				if (isPromise(r)) {
					return r.then(() => runBlocks(i + 1));
				}
			}
			return obj;
		};
		return runStep(0);
	}

	// =====================================================================
	// Functions
	// =====================================================================

	compileFunction(fn: FunctionDef, ownerClass: ClassInfo | null): (env: Env) => VFunctionValue {
		const sema = semaOf(fn);
		const frameSize = Math.max(sema.frameSize ?? 0, fn.params.length + 1);
		const fnType = sema.type;
		const effects = fnType && fnType.k === 'func' ? fnType.effects : null;
		const isDecides = !!effects?.decides;
		const selfSlot = sema.selfSlot;

		const params = fn.params.map((p, i) => ({
			name: p.name,
			named: p.named,
			slot: (p as { sema?: SemaData }).sema?.slot ?? i,
			defaultCode: p.defaultValue ? this.compileExpr(p.defaultValue) : null,
		}));
		const positionalParams = params.filter((p) => !p.named);

		const previousFail = this.fnCtx.failSoft;
		const previousClass = this.fnCtx.currentClass;
		const previousNames = this.fnCtx.names;
		const previousSawBranch = this.fnCtx.sawBranch;
		this.fnCtx.failSoft = isDecides;
		this.fnCtx.currentClass = ownerClass;
		this.fnCtx.sawBranch = false;
		const names: (string | undefined)[] = [];
		for (const p of params) {
			names[p.slot] = p.name;
		}
		this.fnCtx.names = this.debug ? names : null;
		const body = fn.body ? this.compileExpr(fn.body) : null;
		const hasBranch = this.fnCtx.sawBranch;
		this.fnCtx.failSoft = previousFail;
		this.fnCtx.currentClass = previousClass;
		this.fnCtx.names = previousNames;
		this.fnCtx.sawBranch = previousSawBranch;

		const debug = this.debug;
		const fnName = fn.name;
		const line = fn.span.start.line;
		const file = this.currentFile;
		// Simple shape: all-positional parameters, no defaults. These bind
		// through a specialized fast path with no per-param branching.
		const isSimple = params.every((p) => !p.named && !p.defaultCode);
		const paramSlots = params.map((p) => p.slot);
		const paramCount = params.length;

		return (captureEnv: Env) => {
			const runBody = (env: Env, ctx: Ctx): unknown => {
				if (!body) {
					return undefined;
				}
				if (debug && ctx.shared.debug) {
					ctx.shared.debug.onEnterFunction(fnName, line, file);
				}
				// Scope for `branch` blocks: cancelled when we return.
				const savedBranchTasks = ctx.branchTasks;
				const myBranchTasks = hasBranch ? [] : null;
				if (hasBranch) {
					ctx.branchTasks = myBranchTasks;
				}
				const finish = (r: unknown): unknown => {
					if (hasBranch) {
						ctx.branchTasks = savedBranchTasks;
						for (const t of myBranchTasks as { cancel(): void }[]) {
							t.cancel();
						}
					}
					if (debug && ctx.shared.debug) {
						ctx.shared.debug.onLeaveFunction();
					}
					return r;
				};
				try {
					const r = body(env, ctx);
					if (isPromise(r)) {
						return r.then(finish, (error) => {
							if (error instanceof ReturnSignal) {
								return finish(error.value);
							}
							finish(undefined);
							throw error;
						});
					}
					return finish(r);
				} catch (error) {
					if (error instanceof ReturnSignal) {
						return finish(error.value);
					}
					finish(undefined);
					throw error;
				}
			};

			const simpleInvoke = (self: Value, args: Value[], ctx: Ctx): unknown => {
				if (ctx.shared.scheduler.runCancelled) {
					ctx.task.throwIfCancelled();
				}
				const slots = new Array(frameSize);
				// Tuple splat: F(T) where T matches multiple params.
				let positional = args;
				if (positional.length === 1 && paramCount > 1 && positional[0] instanceof VTuple) {
					positional = (positional[0] as VTuple).elements;
				}
				if (positional.length < paramCount) {
					throw new VerseRuntimeError(`Too few arguments calling '${fnName}'`);
				}
				for (let i = 0; i < paramCount; i++) {
					slots[paramSlots[i]] = copyIfStruct(positional[i]);
				}
				if (selfSlot !== undefined) {
					slots[selfSlot] = self;
				}
				const env: Env = {
					slots,
					parent: captureEnv,
					self,
					names: debug ? names : undefined,
				};
				return runBody(env, ctx);
			};

			const genericInvoke = (self: Value, args: Value[], ctx: Ctx, named?: Map<string, Value>): unknown => {
				if (ctx.shared.scheduler.runCancelled) {
					ctx.task.throwIfCancelled();
				}
				const env: Env = {
					slots: new Array(frameSize),
					parent: captureEnv,
					self,
					names: debug ? names : undefined,
				};

				// Tuple splat: F(T) where T matches multiple params.
				let positional = args;
				if (positional.length === 1 && positional[0] instanceof VTuple && positionalParams.length > 1) {
					positional = (positional[0] as VTuple).elements;
				}

				let positionalIndex = 0;
				let pending: Promise<unknown> | null = null;
				for (const param of params) {
					let value: unknown;
					if (param.named) {
						value = named?.has(param.name) ? named.get(param.name) : undefined;
						if (value === undefined && !named?.has(param.name)) {
							if (!param.defaultCode) {
								throw new VerseRuntimeError(`Missing named argument '?${param.name}' calling '${fnName}'`);
							}
							value = param.defaultCode(env, ctx);
						}
					} else if (positionalIndex < positional.length) {
						value = positional[positionalIndex++];
					} else if (param.defaultCode) {
						value = param.defaultCode(env, ctx);
					} else {
						throw new VerseRuntimeError(`Too few arguments calling '${fnName}'`);
					}
					if (isPromise(value)) {
						pending = value.then((v) => {
							env.slots[param.slot] = copyIfStruct(v as Value);
						});
						break;
					}
					env.slots[param.slot] = copyIfStruct(value as Value);
				}
				if (pending) {
					// Rare: default value suspended; finish binding async.
					return pending.then(() => runBody(env, ctx));
				}
				if (selfSlot !== undefined) {
					env.slots[selfSlot] = self;
				}
				return runBody(env, ctx);
			};

			const invoke = isSimple ? simpleInvoke : genericInvoke;
			return new VFunctionValue(fnName, invoke as unknown as (self: Value, args: Value[]) => unknown);
		};
	}

	// =====================================================================
	// Statements & blocks
	// =====================================================================

	compileStatement(stmt: Expr, discardValue = false): Code {
		// Statement-position `for` loops don't collect their per-iteration
		// results (which would retain every value produced in a long loop).
		const inner = discardValue && stmt.kind === 'ForExpr'
			? this.compileFor(stmt, true)
			: this.compileExpr(stmt);
		const line = stmt.span.start.line;
		const file = this.currentFile;
		const failSoft = this.fnCtx.failSoft;
		if (this.debug) {
			return (env, ctx) => {
				ctx.line = line;
				ctx.file = file;
				const hook = ctx.shared.debug?.onStatement(line, file, ctx, env);
				return chain(hook, () => {
					const r = inner(env, ctx);
					if (r === FAIL && !failSoft) {
						throw new VerseRuntimeError('Expression failed outside a failure context', line);
					}
					return r;
				});
			};
		}
		return (env, ctx) => {
			ctx.line = line;
			ctx.file = file;
			const r = inner(env, ctx);
			if (r === FAIL && !failSoft) {
				throw new VerseRuntimeError('Expression failed outside a failure context', line);
			}
			return r;
		};
	}

	private compileBlock(block: Block): Code {
		const hasDefer = block.exprs.some((e) => e.kind === 'DeferExpr');
		// Only the last statement's value can become the block's value.
		const stmts = block.exprs.map((e, i) =>
			this.compileStatement(e, i < block.exprs.length - 1));
		const failSoft = this.fnCtx.failSoft;

		const runSeq = (env: Env, ctx: Ctx): unknown => {
			let last: unknown = undefined;
			for (let i = 0; i < stmts.length; i++) {
				const r = stmts[i](env, ctx);
				if (isPromise(r)) {
					return r.then((first) => runRest(first, i + 1, env, ctx));
				}
				if (r === FAIL) {
					return failSoft ? FAIL : last;
				}
				last = r;
			}
			return last;
		};
		const runRest = async (first: unknown, start: number, env: Env, ctx: Ctx): Promise<unknown> => {
			let last: unknown = first;
			if (last === FAIL && failSoft) {
				return FAIL;
			}
			for (let i = start; i < stmts.length; i++) {
				const r = await stmts[i](env, ctx);
				if (r === FAIL) {
					return failSoft ? FAIL : last;
				}
				last = r;
			}
			return last;
		};

		if (!hasDefer) {
			return runSeq;
		}
		return (env, ctx) => {
			const defers: Code[] = [];
			const savedDefers = ctx.defers;
			ctx.defers = defers as unknown[];
			const runDefers = () => {
				ctx.defers = savedDefers;
				for (let i = defers.length - 1; i >= 0; i--) {
					try {
						const r = defers[i](env, ctx);
						if (isPromise(r)) {
							r.catch(() => {});
						}
					} catch {
						// Defer bodies must not throw; swallow to keep unwinding.
					}
				}
			};
			try {
				const r = runSeq(env, ctx);
				if (isPromise(r)) {
					return r.then(
						(value) => { runDefers(); return value; },
						(error) => { runDefers(); throw error; },
					);
				}
				runDefers();
				return r;
			} catch (error) {
				runDefers();
				throw error;
			}
		};
	}

	// =====================================================================
	// Expressions
	// =====================================================================

	compileExpr(expr: Expr): Code {
		switch (expr.kind) {
			case 'IntLit': {
				const v = expr.value;
				return () => v;
			}
			case 'FloatLit': {
				const v = expr.value;
				return () => v;
			}
			case 'CharLit': {
				const v = expr.value;
				return () => v;
			}
			case 'LogicLit': {
				const v = expr.value;
				return () => v;
			}
			case 'StringLit':
				return this.compileStringLit(expr);
			case 'Ident':
				return this.compileIdent(expr);
			case 'SelfExpr':
				return (env) => env.self;
			case 'Placeholder':
				return () => undefined;
			case 'Interpolant':
				return this.compileExpr(expr.expr);
			case 'Block':
				return this.compileBlock(expr);
			case 'Tuple': {
				const list = this.compileList(expr.elements);
				return (env, ctx) => chain(list(env, ctx), (values) =>
					values === FAIL ? FAIL : new VTuple(values as Value[]));
			}
			case 'ArrayLit': {
				const list = this.compileList(expr.elements);
				return (env, ctx) => list(env, ctx);
			}
			case 'MapLit': {
				const keys = this.compileList(expr.entries.map((e) => e.key));
				const values = this.compileList(expr.entries.map((e) => e.value));
				return (env, ctx) => chain(keys(env, ctx), (ks) => {
					if (ks === FAIL) {
						return FAIL;
					}
					return chain(values(env, ctx), (vs) => {
						if (vs === FAIL) {
							return FAIL;
						}
						const map = new VMap();
						(ks as Value[]).forEach((k, i) => map.set(k, (vs as Value[])[i]));
						return map;
					});
				});
			}
			case 'OptionLit': {
				if (!expr.value) {
					return () => VOption.EMPTY;
				}
				const inner = this.compileFailureContext(
					[expr.value], true, semaOf(expr).contextWrites !== false);
				return (env, ctx) => chain(inner(env, ctx), (r) =>
					r === FAIL ? VOption.EMPTY : VOption.someAllowingUndefined(r as Value));
			}
			case 'RangeExpr': {
				const low = this.compileExpr(expr.low);
				const high = this.compileExpr(expr.high);
				return (env, ctx) => chain(low(env, ctx), (lo) => {
					if (lo === FAIL) {
						return FAIL;
					}
					return chain(high(env, ctx), (hi) => {
						if (hi === FAIL) {
							return FAIL;
						}
						const result: Value[] = [];
						for (let i = lo as number; i <= (hi as number); i++) {
							result.push(i);
						}
						return result;
					});
				});
			}
			case 'TypeLit':
				return () => new VTypeValue('type', null, (v) => v);
			case 'Unary':
				return this.compileUnary(expr);
			case 'Binary':
				return this.compileBinary(expr);
			case 'AndExpr': {
				const left = this.compileExpr(expr.left);
				const right = this.compileExpr(expr.right);
				return (env, ctx) => chain(left(env, ctx), (l) =>
					l === FAIL ? FAIL : right(env, ctx));
			}
			case 'OrExpr': {
				const left = this.compileExpr(expr.left);
				const right = this.compileExpr(expr.right);
				if (semaOf(expr).contextWrites === false) {
					// Read-only left side: nothing to roll back on failure.
					return (env, ctx) => chain(left(env, ctx), (l) =>
						l === FAIL ? right(env, ctx) : l);
				}
				return (env, ctx) => {
					const saved = ctx.txn;
					const txn = new Transaction(saved);
					ctx.txn = txn;
					const finish = (l: unknown): unknown => {
						ctx.txn = saved;
						if (l === FAIL) {
							txn.rollback();
							return right(env, ctx);
						}
						txn.commit();
						return l;
					};
					return chain(left(env, ctx), finish);
				};
			}
			case 'NotExpr': {
				const operand = this.compileExpr(expr.operand);
				if (semaOf(expr).contextWrites === false) {
					// Read-only operand: nothing to roll back.
					return (env, ctx) => chain(operand(env, ctx), (r) =>
						r === FAIL ? undefined : FAIL);
				}
				return (env, ctx) => {
					const saved = ctx.txn;
					const txn = new Transaction(saved);
					ctx.txn = txn;
					return chain(operand(env, ctx), (r) => {
						ctx.txn = saved;
						txn.rollback(); // `not` always rolls back its operand
						return r === FAIL ? undefined : FAIL;
					});
				};
			}
			case 'QueryExpr': {
				const operand = this.compileExpr(expr.operand);
				return (env, ctx) => chain(operand(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					if (v instanceof VOption) {
						return v.isSet ? v.value : FAIL;
					}
					if (typeof v === 'boolean') {
						return v ? undefined : FAIL;
					}
					if (isTask(v as Value)) {
						return (v as VTask).isComplete() ? undefined : FAIL;
					}
					throw new VerseRuntimeError("'?' applied to a value that is not an option or logic");
				});
			}
			case 'Call':
				return this.compileCall(expr);
			case 'Index': {
				const target = this.compileExpr(expr.target);
				const index = this.compileExpr(expr.index);
				return (env, ctx) => chain(target(env, ctx), (t) =>
					chain(index(env, ctx), (i) => indexValue(t as Value, i as Value)));
			}
			case 'Member':
				return this.compileMember(expr);
			case 'Archetype':
				return this.compileArchetype(expr);
			case 'Definition':
			case 'VarDefinition': {
				const slot = semaOf(expr).slot ?? -1;
				const value = expr.value ? this.compileExpr(expr.value) : null;
				if (this.fnCtx.names && slot >= 0) {
					this.fnCtx.names[slot] = expr.name;
				}
				if (!value) {
					return () => undefined;
				}
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					env.slots[slot] = copyIfStruct(v as Value);
					return undefined;
				});
			}
			case 'Assignment': {
				const slot = semaOf(expr).slot ?? -1;
				const value = this.compileExpr(expr.value);
				if (this.fnCtx.names && slot >= 0) {
					this.fnCtx.names[slot] = expr.name;
				}
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					env.slots[slot] = copyIfStruct(v as Value);
					return v;
				});
			}
			case 'SetExpr':
				return this.compileSet(expr);
			case 'FunctionDef': {
				const slot = semaOf(expr).slot ?? -1;
				const make = this.compileFunction(expr, this.fnCtx.currentClass);
				if (this.fnCtx.names && slot >= 0) {
					this.fnCtx.names[slot] = expr.name;
				}
				return (env) => {
					env.slots[slot] = make(env);
					return undefined;
				};
			}
			case 'IfExpr':
				return this.compileIf(expr);
			case 'CaseExpr':
				return this.compileCase(expr);
			case 'ForExpr':
				return this.compileFor(expr);
			case 'LoopExpr': {
				const body = this.compileStatement(expr.body);
				return (env, ctx) => runLoop(body, null, env, ctx);
			}
			case 'WhileExpr': {
				const condition = this.compileFailureContext(
					[expr.condition], true, semaOf(expr).contextWrites !== false);
				const body = this.compileStatement(expr.body);
				return (env, ctx) => runLoop(body, condition, env, ctx);
			}
			case 'BreakExpr':
				return () => { throw BreakSignal.instance; };
			case 'ReturnExpr': {
				const value = expr.value ? this.compileExpr(expr.value) : null;
				if (!value) {
					return () => { throw new ReturnSignal(undefined); };
				}
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					throw new ReturnSignal(v as Value);
				});
			}
			case 'DeferExpr': {
				const body = this.compileExpr(expr.body);
				return (env, ctx) => {
					if (ctx.defers) {
						ctx.defers.push(body);
					} else {
						throw new VerseRuntimeError("'defer' is not allowed here");
					}
					return undefined;
				};
			}
			case 'SpawnExpr': {
				const body = this.compileExpr(expr.body);
				return (env, ctx) => {
					const scheduler = ctx.shared.scheduler;
					const task = scheduler.spawnTask(scheduler.rootTask, 'spawn', async (t) => {
						const childCtx = ctx.forTask(t);
						const r = body(env, childCtx);
						const value = isPromise(r) ? await r : r;
						return value === FAIL ? undefined : (value as Value);
					});
					return task;
				};
			}
			case 'ConcurrencyBlock':
				return this.compileConcurrency(expr);
			case 'UsingDecl':
				return () => undefined;
			case 'ClassDef':
			case 'ModuleDef':
			case 'EnumDef':
			case 'TypeAliasDef':
				return () => undefined;
			case 'OptionType':
			case 'ArrayType':
			case 'MapType':
			case 'TupleType':
			case 'FunctionType':
			case 'GenericType': {
				const vtype = semaOf(expr).type;
				return () => makeTypeValue(vtype);
			}
			case 'FailureExpr': {
				const keyword = expr.keyword;
				return () => {
					throw new VerseRuntimeError(`'${keyword}' is reserved for future use`);
				};
			}
			case 'ProfileExpr': {
				const label = expr.label ? this.compileExpr(expr.label) : null;
				const body = this.compileExpr(expr.body);
				return (env, ctx) => {
					const start = Date.now();
					const finish = (r: unknown) => {
						const seconds = (Date.now() - start) / 1000;
						const report = (labelValue: unknown) => {
							ctx.shared.profile(verseToString((labelValue ?? 'profile') as Value), seconds);
							return r;
						};
						return label ? chain(label(env, ctx), report) : report(null);
					};
					return chain(body(env, ctx), finish);
				};
			}
		}
	}

	private compileStringLit(expr: Extract<Expr, { kind: 'StringLit' }>): Code {
		// The runtime can't tell a float 3.0 from an int 3 (both JS numbers),
		// so float formatting ("3.0") is decided by the interpolant's static
		// type, captured per part at compile time.
		const parts = expr.parts.map((p) =>
			typeof p === 'string'
				? p
				: {
					code: this.compileExpr(p),
					format: semaOf(p).type?.k === 'float' ? verseFloatToString : verseToString,
				});
		if (parts.every((p) => typeof p === 'string')) {
			const s = parts.join('');
			return () => s;
		}
		return (env, ctx) => {
			let result = '';
			const build = (index: number): unknown => {
				for (let i = index; i < parts.length; i++) {
					const part = parts[i];
					if (typeof part === 'string') {
						result += part;
						continue;
					}
					const r = part.code(env, ctx);
					if (isPromise(r)) {
						return r.then((v) => {
							if (v === FAIL) {
								return FAIL;
							}
							result += part.format(v as Value);
							return build(i + 1);
						});
					}
					if (r === FAIL) {
						return FAIL;
					}
					result += part.format(r as Value);
				}
				return result;
			};
			return build(0);
		};
	}

	private compileIdent(expr: Extract<Expr, { kind: 'Ident' }>): Code {
		const sema = semaOf(expr);
		const binding = sema.binding;
		if (!binding) {
			// Primitive type names as cast targets, or `super` (handled at
			// Member/Call level; bare super is meaningless).
			const name = expr.name;
			const primCast = primitiveCast(name);
			if (primCast) {
				return () => primCast;
			}
			return () => {
				throw new VerseRuntimeError(`Unknown identifier '${name}'`);
			};
		}
		return this.compileBindingLoad(binding, sema);
	}

	private compileBindingLoad(binding: Binding, sema: SemaData): Code {
		switch (binding.kind) {
			case 'local': {
				const depth = sema.frameDepth ?? 0;
				const slot = binding.slot;
				if (depth === 0) {
					return (env) => env.slots[slot];
				}
				return (env) => {
					let e: Env = env;
					for (let i = 0; i < depth; i++) {
						e = e.parent as Env;
					}
					return e.slots[slot];
				};
			}
			case 'global': {
				const slot = binding.slot;
				return (env, ctx) => ctx.shared.globals[slot];
			}
			case 'function': {
				const slot = sema.slot !== undefined && sema.slot >= 0 ? sema.slot : binding.overloads[0].slot;
				return (env, ctx) => ctx.shared.globals[slot];
			}
			case 'member': {
				const name = binding.name;
				const isMethod = binding.isMethod;
				return (env, ctx) => {
					const self = env.self;
					if (!(self instanceof VObject)) {
						throw new VerseRuntimeError(`'${name}' requires 'Self'`);
					}
					if (!isMethod && self.fields.has(name)) {
						return self.fields.get(name);
					}
					return objectMember(self, name, ctx);
				};
			}
			case 'class': {
				const slot = binding.declSlot;
				return (env, ctx) => ctx.shared.globals[slot];
			}
			case 'enum': {
				const info = binding.enumInfo;
				const value = new VTypeValue(info.name, null, (v) =>
					v instanceof VEnumValue && v.enumName === info.name ? v : FAIL);
				return () => value;
			}
			case 'module':
				return () => undefined;
			case 'native':
				return this.compileNativeLoad(binding.export);
			case 'typeParam':
			case 'typeAlias': {
				const value = makeTypeValue(binding.kind === 'typeAlias' ? binding.type : binding.type);
				return () => value;
			}
		}
	}

	private compileNativeLoad(exp: NativeExport): Code {
		const cached = this.nativeValueCache.get(exp);
		if (cached !== undefined) {
			return () => cached;
		}
		const entry = this.registry.lookup(exp.modulePath, exp.name);
		let value: Value;
		if (!entry) {
			value = undefined;
		} else if (entry.kind === 'function') {
			const impl = entry.impl;
			value = new VNativeFunction(entry.name, impl as (args: Value[], ctx: unknown) => unknown);
		} else if (entry.kind === 'class') {
			value = new NativeClassValue(entry);
		} else if (entry.kind === 'value') {
			value = entry.value;
		} else {
			const info = entry.info;
			value = new VTypeValue(info.name, null, (v) =>
				v instanceof VEnumValue && v.enumName === info.name ? v : FAIL);
		}
		this.nativeValueCache.set(exp, value);
		return () => value;
	}

	// =====================================================================
	// Operators
	// =====================================================================

	private compileUnary(expr: Extract<Expr, { kind: 'Unary' }>): Code {
		const operand = this.compileExpr(expr.operand);
		const op = expr.op;
		return (env, ctx) => chain(operand(env, ctx), (v) => {
			if (v === FAIL) {
				return FAIL;
			}
			if (op === '+') {
				return v;
			}
			if (v instanceof VRational) {
				return new VRational(-v.num, v.den);
			}
			return -(v as number);
		});
	}

	private compileBinary(expr: Extract<Expr, { kind: 'Binary' }>): Code {
		const left = this.compileExpr(expr.left);
		const right = this.compileExpr(expr.right);
		const op = expr.op;
		const line = expr.span.start.line;
		// JS numbers can't distinguish 5.0 from 5, so int-vs-float division
		// must be decided statically: float / float is plain IEEE division,
		// not the failable int/int -> rational form.
		if (op === '/' && (semaOf(expr.left).type?.k === 'float' || semaOf(expr.right).type?.k === 'float')) {
			return (env, ctx) => evalBinary(left, right, env, ctx, floatDivide);
		}
		// string + float concatenation: format the float side with its
		// trailing ".0" (same static-type reasoning as division above).
		const leftKind = semaOf(expr.left).type?.k;
		const rightKind = semaOf(expr.right).type?.k;
		if (op === '+' &&
			((leftKind === 'string' && rightKind === 'float') ||
				(leftKind === 'float' && rightKind === 'string'))) {
			const floatOnLeft = leftKind === 'float';
			const concat: BinaryFn = floatOnLeft
				? (l, r) => verseFloatToString(l) + (r as string)
				: (l, r) => (l as string) + verseFloatToString(r);
			return (env, ctx) => evalBinary(left, right, env, ctx, concat);
		}
		// Pick the operator implementation once at compile time: statically
		// numeric/string operands skip applyBinary's dynamic dispatch.
		const apply = selectBinaryOp(op, leftKind, rightKind, line);
		return (env, ctx) => evalBinary(left, right, env, ctx, apply);
	}

	// =====================================================================
	// Calls, members, archetypes
	// =====================================================================

	private compileList(exprs: Expr[]): (env: Env, ctx: Ctx) => unknown {
		const codes = exprs.map((e) => this.compileExpr(e));
		return (env, ctx) => {
			const out: Value[] = new Array(codes.length);
			for (let i = 0; i < codes.length; i++) {
				const r = codes[i](env, ctx);
				if (isPromise(r)) {
					return r.then(async (first) => {
						if (first === FAIL) {
							return FAIL;
						}
						out[i] = first as Value;
						for (let j = i + 1; j < codes.length; j++) {
							const v = await codes[j](env, ctx);
							if (v === FAIL) {
								return FAIL;
							}
							out[j] = v as Value;
						}
						return out;
					});
				}
				if (r === FAIL) {
					return FAIL;
				}
				out[i] = r as Value;
			}
			return out;
		};
	}

	private compileCall(expr: Call): Code {
		const sema = semaOf(expr);
		const callMode = sema.callMode;
		const failable = expr.failable;
		const line = expr.span.start.line;

		// Super method call: (super:)Method(args)
		if (
			expr.callee.kind === 'Member' &&
			semaOf(expr.callee).memberMode === 'super'
		) {
			return this.compileSuperCall(expr);
		}

		// ToString(float): float formatting is a static-type decision (the
		// runtime can't tell 3.0 from 3), so specialize the call here.
		const calleeBinding = semaOf(expr.callee).binding;
		if (
			calleeBinding?.kind === 'native' &&
			calleeBinding.export.name === 'ToString' &&
			expr.args.length === 1 && expr.args[0].name === null &&
			semaOf(expr.args[0].value).type?.k === 'float'
		) {
			const arg = this.compileExpr(expr.args[0].value);
			return (env, ctx) => chain(arg(env, ctx), (v) =>
				v === FAIL ? FAIL : verseFloatToString(v as Value));
		}

		const callee = this.compileExpr(expr.callee);

		if (callMode === 'construct') {
			// Generic type application: evaluate callee only (type erasure).
			return (env, ctx) => callee(env, ctx);
		}

		const positionalArgs = this.compileList(expr.args.filter((a) => a.name === null).map((a) => a.value));
		const namedArgs = expr.args
			.filter((a) => a.name !== null)
			.map((a) => ({ name: a.name as string, code: this.compileExpr(a.value) }));

		// Sync-first fast path for the common shape (no named arguments):
		// callee and argument evaluation allocate no continuation closures
		// unless something actually suspends.
		if (namedArgs.length === 0) {
			return (env, ctx) => {
				const c = callee(env, ctx);
				if (isPromise(c)) {
					return c.then((cv) => {
						if (cv === FAIL) {
							return FAIL;
						}
						return chain(positionalArgs(env, ctx), (args) =>
							args === FAIL
								? FAIL
								: dispatchCall(cv as Value, args as Value[], undefined, ctx, failable, line));
					});
				}
				if (c === FAIL) {
					return FAIL;
				}
				const args = positionalArgs(env, ctx);
				if (isPromise(args)) {
					return args.then((a) =>
						a === FAIL
							? FAIL
							: dispatchCall(c as Value, a as Value[], undefined, ctx, failable, line));
				}
				if (args === FAIL) {
					return FAIL;
				}
				return dispatchCall(c as Value, args as Value[], undefined, ctx, failable, line);
			};
		}

		return (env, ctx) => chain(callee(env, ctx), (calleeValue) => {
			if (calleeValue === FAIL) {
				return FAIL;
			}
			return chain(positionalArgs(env, ctx), (args) => {
				if (args === FAIL) {
					return FAIL;
				}
				const named = new Map<string, Value>();
				const evalNamed = (index: number): unknown => {
					for (let i = index; i < namedArgs.length; i++) {
						const r = namedArgs[i].code(env, ctx);
						if (isPromise(r)) {
							return r.then((v) => {
								if (v === FAIL) {
									return FAIL;
								}
								named.set(namedArgs[i].name, v as Value);
								return evalNamed(i + 1);
							});
						}
						if (r === FAIL) {
							return FAIL;
						}
						named.set(namedArgs[i].name, r as Value);
					}
					return dispatchCall(calleeValue as Value, args as Value[], named, ctx, failable, line);
				};
				return evalNamed(0);
			});
		});
	}

	private compileSuperCall(expr: Call): Code {
		const memberName = (expr.callee as Extract<Expr, { kind: 'Member' }>).name;
		const currentClass = this.fnCtx.currentClass;
		const args = this.compileList(expr.args.filter((a) => a.name === null).map((a) => a.value));
		const line = expr.span.start.line;
		const classMap = this.classMap;
		return (env, ctx) => chain(args(env, ctx), (argValues) => {
			if (argValues === FAIL) {
				return FAIL;
			}
			const superInfo = currentClass?.supers.find((s) => s.kind === 'class') ?? currentClass?.supers[0];
			const superRc = superInfo ? classMap.get(superInfo) : null;
			const method = superRc?.methods.get(memberName);
			if (!method) {
				throw new VerseRuntimeError(`No superclass method '${memberName}'`, line);
			}
			const resolved = resolveMethod(method, ctx);
			return (resolved.invoke as (self: Value, args: Value[], ctx: Ctx) => unknown)(env.self, argValues as Value[], ctx);
		});
	}

	private compileMember(expr: Extract<Expr, { kind: 'Member' }>): Code {
		const sema = semaOf(expr);
		const name = expr.name;

		if (sema.memberMode === 'binding' && sema.memberBinding) {
			return this.compileBindingLoad(sema.memberBinding, sema);
		}
		if (sema.memberMode === 'enumValue' && sema.enumInfo) {
			const info = sema.enumInfo;
			const ordinal = info.values.indexOf(name);
			const value = new VEnumValue(info.name, name, ordinal);
			return () => value;
		}
		if (sema.memberMode === 'extension' && sema.extensionSlot !== undefined) {
			const target = this.compileExpr(expr.target);
			const slot = sema.extensionSlot;
			return (env, ctx) => chain(target(env, ctx), (t) => {
				if (t === FAIL) {
					return FAIL;
				}
				const fn = ctx.shared.globals[slot];
				if (fn instanceof VFunctionValue) {
					return fn.bind(t as Value);
				}
				throw new VerseRuntimeError(`Extension method '${name}' is not available`);
			});
		}
		if (sema.memberMode === 'super') {
			// Bare (super:)X without call: resolve as bound method.
			const currentClass = this.fnCtx.currentClass;
			const classMap = this.classMap;
			return (env, ctx) => {
				const superInfo = currentClass?.supers[0];
				const superRc = superInfo ? classMap.get(superInfo) : null;
				const method = superRc?.methods.get(name);
				if (!method) {
					throw new VerseRuntimeError(`No superclass member '${name}'`);
				}
				return resolveMethod(method, ctx).bind(env.self);
			};
		}

		const target = this.compileExpr(expr.target);
		return (env, ctx) => {
			const t = target(env, ctx);
			if (isPromise(t)) {
				return t.then((tv) => (tv === FAIL ? FAIL : memberValue(tv as Value, name, ctx)));
			}
			if (t === FAIL) {
				return FAIL;
			}
			return memberValue(t as Value, name, ctx);
		};
	}

	private compileArchetype(expr: Archetype): Code {
		// logic{e}: failure-to-logic conversion.
		if (expr.callee.kind === 'Ident' && expr.callee.name === 'logic' && expr.body.length === 1) {
			const inner = this.compileFailureContext([expr.body[0]], true);
			return (env, ctx) => chain(inner(env, ctx), (r) => r !== FAIL);
		}
		const callee = this.compileExpr(expr.callee);
		const fieldNames = expr.fields.map((f) => f.name);
		const fieldValues = this.compileList(expr.fields.map((f) => f.value));
		const bodyValues = this.compileList(expr.body);
		const line = expr.span.start.line;

		return (env, ctx) => chain(callee(env, ctx), (cls) => {
			if (cls === FAIL) {
				return FAIL;
			}
			return chain(fieldValues(env, ctx), (values) => {
				if (values === FAIL) {
					return FAIL;
				}
				return chain(bodyValues(env, ctx), (body) => {
					if (body === FAIL) {
						return FAIL;
					}
					const provided = new Map<string, unknown>();
					fieldNames.forEach((n, i) => provided.set(n, (values as Value[])[i]));

					if (cls instanceof RuntimeClass) {
						return this.instantiate(cls, provided, env, ctx);
					}
					if (cls instanceof NativeClassValue) {
						if (!cls.entry.construct) {
							throw new VerseRuntimeError(`'${cls.entry.name}' cannot be constructed directly`, line);
						}
						return cls.entry.construct(provided as Map<string, Value>, ctx);
					}
					// logic{expr}: succeed -> true, fail -> false (failure ctx).
					if (cls instanceof VTypeValue && cls.name === 'logic') {
						const b = (body as Value[])[0];
						return b !== undefined ? true : false;
					}
					throw new VerseRuntimeError('Archetype instantiation requires a class', line);
				});
			});
		});
	}

	// =====================================================================
	// set
	// =====================================================================

	private compileSet(stmt: SetExpr): Code {
		const op = stmt.op;
		const value = this.compileExpr(stmt.value);
		const line = stmt.span.start.line;
		const target = stmt.target;

		const applyOp = (oldValue: Value, newValue: Value): Value => {
			if (op === '=') {
				return copyIfStruct(newValue);
			}
			const binOp = op[0] as '+' | '-' | '*' | '/';
			const result = applyBinary(binOp, oldValue, newValue, line);
			if (result === FAIL) {
				throw new VerseRuntimeError(`'${op}' failed`, line);
			}
			return result as Value;
		};

		if (target.kind === 'Ident') {
			const sema = semaOf(target);
			const binding = sema.binding;
			if (binding?.kind === 'local') {
				const depth = sema.frameDepth ?? 0;
				const slot = binding.slot;
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					let e: Env = env;
					for (let i = 0; i < depth; i++) {
						e = e.parent as Env;
					}
					if (ctx.txn) {
						ctx.txn.recordSlot(e.slots, slot);
					}
					e.slots[slot] = op === '=' ? copyIfStruct(v as Value) : applyOp(e.slots[slot], v as Value);
					return e.slots[slot];
				});
			}
			if (binding?.kind === 'global') {
				const slot = binding.slot;
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					const globals = ctx.shared.globals;
					if (ctx.txn) {
						ctx.txn.recordSlot(globals, slot);
					}
					globals[slot] = op === '=' ? copyIfStruct(v as Value) : applyOp(globals[slot], v as Value);
					persistIfNeeded(ctx, globals[slot]);
					return globals[slot];
				});
			}
			if (binding?.kind === 'member') {
				const name = binding.name;
				return (env, ctx) => chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					const self = env.self;
					if (!(self instanceof VObject)) {
						throw new VerseRuntimeError(`Cannot assign '${name}' without Self`, line);
					}
					if (ctx.txn) {
						ctx.txn.recordField(self, name);
					}
					const next = op === '=' ? copyIfStruct(v as Value) : applyOp(self.fields.get(name), v as Value);
					self.fields.set(name, next);
					return next;
				});
			}
			return () => {
				throw new VerseRuntimeError('Invalid assignment target', line);
			};
		}

		if (target.kind === 'Member') {
			const object = this.compileExpr(target.target);
			const name = target.name;
			return (env, ctx) => chain(object(env, ctx), (o) => {
				if (o === FAIL) {
					return FAIL;
				}
				return chain(value(env, ctx), (v) => {
					if (v === FAIL) {
						return FAIL;
					}
					if (!(o instanceof VObject)) {
						throw new VerseRuntimeError(`Cannot assign member '${name}' of a non-object`, line);
					}
					if (ctx.txn) {
						ctx.txn.recordField(o, name);
					}
					const next = op === '=' ? copyIfStruct(v as Value) : applyOp(o.fields.get(name), v as Value);
					o.fields.set(name, next);
					return next;
				});
			});
		}

		if (target.kind === 'Call' && target.failable) {
			const container = this.compileExpr(target.callee);
			const index = this.compileExpr(target.args[0]?.value ?? target.callee);
			return (env, ctx) => chain(container(env, ctx), (c) => {
				if (c === FAIL) {
					return FAIL;
				}
				return chain(index(env, ctx), (i) => {
					if (i === FAIL) {
						return FAIL;
					}
					return chain(value(env, ctx), (v) => {
						if (v === FAIL) {
							return FAIL;
						}
						if (Array.isArray(c)) {
							const idx = i as number;
							if (!Number.isInteger(idx) || idx < 0 || idx >= c.length) {
								return FAIL;
							}
							if (ctx.txn) {
								ctx.txn.recordElem(c, idx);
							}
							c[idx] = op === '=' ? copyIfStruct(v as Value) : applyOp(c[idx], v as Value);
							return c[idx];
						}
						if (c instanceof VMap) {
							if (ctx.txn) {
								ctx.txn.recordMapEntry(c, i as Value);
							}
							const old = c.get(i as Value);
							const next = op === '=' ? copyIfStruct(v as Value) : applyOp(old === FAIL ? undefined : old, v as Value);
							c.set(i as Value, next);
							persistIfNeeded(ctx, c);
							return next;
						}
						throw new VerseRuntimeError('Indexed assignment requires an array or map', line);
					});
				});
			});
		}

		return () => {
			throw new VerseRuntimeError('Invalid assignment target', line);
		};
	}

	// =====================================================================
	// Control flow
	// =====================================================================

	/**
	 * Runs `exprs` in a transaction; FAIL rolls back. Returns last value.
	 * When the checker proved the context read-only (`canWrite` false),
	 * compiles a plain fail-check with no transaction at all.
	 */
	private compileFailureContext(exprs: Expr[], commitOnSuccess: boolean, canWrite = true): Code {
		const codes = exprs.map((e) => this.compileExpr(e));
		if (!canWrite) {
			return (env, ctx) => {
				const runFrom = (index: number, last: unknown): unknown => {
					for (let i = index; i < codes.length; i++) {
						const r = codes[i](env, ctx);
						if (isPromise(r)) {
							return r.then((v) => (v === FAIL ? FAIL : runFrom(i + 1, v)));
						}
						if (r === FAIL) {
							return FAIL;
						}
						last = r;
					}
					return last;
				};
				return runFrom(0, undefined);
			};
		}
		return (env, ctx) => {
			const saved = ctx.txn;
			const txn = new Transaction(saved);
			ctx.txn = txn;
			const finish = (r: unknown): unknown => {
				ctx.txn = saved;
				if (r === FAIL) {
					txn.rollback();
					return FAIL;
				}
				if (commitOnSuccess) {
					txn.commit();
				} else {
					txn.rollback();
				}
				return r;
			};
			const runFrom = (index: number, last: unknown): unknown => {
				for (let i = index; i < codes.length; i++) {
					const r = codes[i](env, ctx);
					if (isPromise(r)) {
						return r.then((v) => (v === FAIL ? finish(FAIL) : runFrom(i + 1, v)));
					}
					if (r === FAIL) {
						return finish(FAIL);
					}
					last = r;
				}
				return finish(last);
			};
			try {
				return runFrom(0, undefined);
			} catch (error) {
				ctx.txn = saved;
				txn.rollback();
				throw error;
			}
		};
	}

	private compileIf(expr: IfExpr): Code {
		const clauseWrites = semaOf(expr).clauseWrites;
		const clauses = expr.clauses.map((clause, i) => ({
			conditions: this.compileFailureContext(
				clause.conditions, true, clauseWrites?.[i] !== false),
			body: this.compileExpr(clause.body),
		}));
		const elseBody = expr.elseBody ? this.compileExpr(expr.elseBody) : null;

		return (env, ctx) => {
			// Sync-first: iterate clauses in a loop; only fall back to a
			// promise continuation when a condition actually suspends.
			const tryClause = (index: number): unknown => {
				for (let i = index; i < clauses.length; i++) {
					const clause = clauses[i];
					const r = clause.conditions(env, ctx);
					if (isPromise(r)) {
						return r.then((result) =>
							result === FAIL ? tryClause(i + 1) : clause.body(env, ctx));
					}
					if (r !== FAIL) {
						return clause.body(env, ctx);
					}
				}
				return elseBody ? elseBody(env, ctx) : undefined;
			};
			return tryClause(0);
		};
	}

	private compileCase(expr: CaseExpr): Code {
		const subject = this.compileExpr(expr.subject);
		const arms = expr.arms.map((arm) => ({
			pattern: arm.pattern ? this.compileExpr(arm.pattern) : null,
			body: this.compileExpr(arm.body),
		}));
		const line = expr.span.start.line;

		return (env, ctx) => chain(subject(env, ctx), (s) => {
			if (s === FAIL) {
				return FAIL;
			}
			const tryArm = (index: number): unknown => {
				if (index >= arms.length) {
					throw new VerseRuntimeError("No case pattern matched (add a '_' arm)", line);
				}
				const arm = arms[index];
				if (!arm.pattern) {
					return arm.body(env, ctx);
				}
				return chain(arm.pattern(env, ctx), (p) => {
					if (p !== FAIL && verseEquals(s as Value, p as Value)) {
						return arm.body(env, ctx);
					}
					return tryArm(index + 1);
				});
			};
			return tryArm(0);
		});
	}

	private compileFor(expr: ForExpr, discardResults = false): Code {
		interface GenSpec {
			slot: number;
			valueSlot: number | null;
			iterable: Code | null;
			/** Integer range generator: iterate numerically, no array. */
			range: { low: Code; high: Code } | null;
		}
		const generators: GenSpec[] = expr.generators.map((g) => {
			const isLazyRange = g.iterable.kind === 'RangeExpr' && !g.valueName;
			return {
				slot: (g as { sema?: SemaData }).sema?.slot ?? -1,
				valueSlot: (g as { semaValue?: SemaData }).semaValue?.slot ?? null,
				iterable: isLazyRange ? null : this.compileExpr(g.iterable),
				range: isLazyRange && g.iterable.kind === 'RangeExpr'
					? { low: this.compileExpr(g.iterable.low), high: this.compileExpr(g.iterable.high) }
					: null,
			};
		});
		if (this.fnCtx.names) {
			expr.generators.forEach((g, i) => {
				const spec = generators[i];
				if (spec.slot >= 0 && this.fnCtx.names) {
					this.fnCtx.names[spec.slot] = g.name;
				}
				if (spec.valueSlot !== null && g.valueName && this.fnCtx.names) {
					this.fnCtx.names[spec.valueSlot] = g.valueName;
				}
			});
		}
		const filters = expr.filters.map((f) => this.compileExpr(f));
		// No transaction when there are no filters, or the checker proved
		// them read-only — there is nothing to roll back on a failing filter.
		const filtersCanWrite = filters.length > 0 && semaOf(expr).contextWrites !== false;
		const body = this.compileStatement(expr.body);
		const line = expr.span.start.line;

		return (env, ctx) => {
			const results: Value[] = [];

			// Resolve iterables up front (each may be async). Range
			// generators resolve to numeric bounds; no array is built.
			const iterables: (Value[] | [Value, Value][])[] = [];
			const bounds: [number, number][] = [];
			const resolveIter = (index: number): unknown => {
				if (index >= generators.length) {
					return runProduct(0);
				}
				const gen = generators[index];
				if (gen.range) {
					const { low, high } = gen.range;
					return chain(low(env, ctx), (lo) => {
						if (lo === FAIL) {
							return results;
						}
						return chain(high(env, ctx), (hi) => {
							if (hi === FAIL) {
								return results;
							}
							bounds[index] = [lo as number, hi as number];
							return resolveIter(index + 1);
						});
					});
				}
				const r = (gen.iterable as Code)(env, ctx);
				return chain(r, (value) => {
					if (value === FAIL) {
						// Failing generator: zero iterations.
						return results;
					}
					iterables[index] = normalizeIterable(value as Value, line);
					return resolveIter(index + 1);
				});
			};

			// Cartesian product over generators, applying filters per combo.
			const runProduct = (genIndex: number): unknown => {
				if (genIndex === generators.length) {
					return runFiltersAndBody();
				}
				const gen = generators[genIndex];
				if (gen.range) {
					const [lo, hi] = bounds[genIndex];
					const iterateRange = (from: number): unknown => {
						for (let v = from; v <= hi; v++) {
							env.slots[gen.slot] = v;
							const r = runProduct(genIndex + 1);
							if (isPromise(r)) {
								return r.then(() => iterateRange(v + 1));
							}
						}
						return undefined;
					};
					return iterateRange(lo);
				}
				const items = iterables[genIndex];
				const iterate = (itemIndex: number): unknown => {
					for (let i = itemIndex; i < items.length; i++) {
						const item = items[i];
						if (gen.valueSlot !== null) {
							const [k, v] = item as [Value, Value];
							env.slots[gen.slot] = k;
							env.slots[gen.valueSlot] = v;
						} else {
							env.slots[gen.slot] = item as Value;
						}
						const r = runProduct(genIndex + 1);
						if (isPromise(r)) {
							return r.then(() => iterate(i + 1));
						}
					}
					return undefined;
				};
				return iterate(0);
			};

			const runBody = (): unknown => {
				const b = body(env, ctx);
				return chain(b, (value) => {
					if (!discardResults && value !== FAIL) {
						results.push(value as Value);
					}
					return undefined;
				});
			};

			const runFiltersAndBody = filters.length === 0 ? runBody : (): unknown => {
				if (!filtersCanWrite) {
					// Read-only (or absent) filters: a FAIL just skips the
					// combo; nothing needs rolling back.
					const checkPlain = (index: number): unknown => {
						for (let i = index; i < filters.length; i++) {
							const r = filters[i](env, ctx);
							if (isPromise(r)) {
								return r.then((v) => (v === FAIL ? undefined : checkPlain(i + 1)));
							}
							if (r === FAIL) {
								return undefined;
							}
						}
						return runBody();
					};
					return checkPlain(0);
				}
				// Filters are failable; a failing filter skips this combo.
				const saved = ctx.txn;
				const txn = new Transaction(saved);
				ctx.txn = txn;
				const checkFilter = (index: number): unknown => {
					for (let i = index; i < filters.length; i++) {
						const r = filters[i](env, ctx);
						if (isPromise(r)) {
							return r.then((v) => (v === FAIL ? skip() : checkFilter(i + 1)));
						}
						if (r === FAIL) {
							return skip();
						}
					}
					ctx.txn = saved;
					txn.commit();
					return runBody();
				};
				const skip = (): unknown => {
					ctx.txn = saved;
					txn.rollback();
					return undefined;
				};
				try {
					return checkFilter(0);
				} catch (error) {
					ctx.txn = saved;
					txn.rollback();
					throw error;
				}
			};

			try {
				const r = resolveIter(0);
				if (isPromise(r)) {
					return r.then(
						() => results,
						(error) => {
							if (error instanceof BreakSignal) {
								return results;
							}
							throw error;
						},
					);
				}
				return results;
			} catch (error) {
				if (error instanceof BreakSignal) {
					return results;
				}
				throw error;
			}
		};
	}

	// =====================================================================
	// Concurrency
	// =====================================================================

	private compileConcurrency(expr: Extract<Expr, { kind: 'ConcurrencyBlock' }>): Code {
		const clauses = expr.clauses.map((c) => this.compileExpr(c));
		const op = expr.op;
		if (op === 'branch') {
			this.fnCtx.sawBranch = true;
		}

		return (env, ctx) => {
			const scheduler = ctx.shared.scheduler;
			const parent = ctx.task;

			if (op === 'branch') {
				const task = scheduler.spawnTask(parent, 'branch', async (t) => {
					const childCtx = ctx.forTask(t);
					const r = clauses[0](env, childCtx);
					const value = isPromise(r) ? await r : r;
					return value === FAIL ? undefined : (value as Value);
				});
				if (ctx.branchTasks) {
					// Cancelled when the enclosing function invocation exits.
					ctx.branchTasks.push(task);
				} else {
					parent.branchChildren.add(task);
				}
				return undefined;
			}

			const tasks = clauses.map((clause, i) =>
				scheduler.spawnTask(parent, `${op}[${i}]`, async (t) => {
					const childCtx = ctx.forTask(t);
					const r = clause(env, childCtx);
					const value = isPromise(r) ? await r : r;
					return value === FAIL ? undefined : (value as Value);
				}));

			if (op === 'sync') {
				return parent.suspendable(
					Promise.all(tasks.map((t) => t.awaitResult())).then((values) => new VTuple(values)),
				).catch((error) => {
					for (const t of tasks) {
						t.cancel();
					}
					throw error;
				});
			}

			// race / rush: first completion wins.
			const first = new Promise<Value>((resolve, reject) => {
				let settled = false;
				for (const t of tasks) {
					t.awaitResult().then(
						(value) => {
							if (!settled) {
								settled = true;
								resolve(value);
							}
						},
						(error) => {
							if (!settled) {
								settled = true;
								reject(error);
							}
						},
					);
				}
			});
			return parent.suspendable(first).then(
				(value) => {
					if (op === 'race') {
						for (const t of tasks) {
							t.cancel();
						}
					}
					return value;
				},
				(error) => {
					for (const t of tasks) {
						t.cancel();
					}
					throw error;
				},
			);
		};
	}
}

// =====================================================================
// Runtime helpers
// =====================================================================

function rootOf(env: Env): Env {
	let e = env;
	while (e.parent) {
		e = e.parent;
	}
	return e;
}

function copyIfStruct(v: Value): Value {
	return v instanceof VStruct ? v.copy() : v;
}

function primitiveCast(name: string): VTypeValue | null {
	switch (name) {
		case 'int':
			return new VTypeValue('int', null, (v) => (typeof v === 'number' && Number.isInteger(v) ? v : FAIL));
		case 'float':
			return new VTypeValue('float', null, (v) => (typeof v === 'number' ? v : FAIL));
		case 'string':
			return new VTypeValue('string', null, (v) => (typeof v === 'string' ? v : FAIL));
		case 'logic':
			return new VTypeValue('logic', null, (v) => (typeof v === 'boolean' ? v : FAIL));
		default:
			return null;
	}
}

function makeTypeValue(vtype: VType | undefined): VTypeValue {
	return new VTypeValue(vtype ? vtype.k : 'type', vtype ?? null, (v) => castByVType(vtype, v));
}

function castByVType(vtype: VType | undefined, v: Value): Value | typeof FAIL {
	if (!vtype) {
		return v;
	}
	switch (vtype.k) {
		case 'int': return typeof v === 'number' && Number.isInteger(v) ? v : FAIL;
		case 'float': return typeof v === 'number' ? v : FAIL;
		case 'string': return typeof v === 'string' ? v : FAIL;
		case 'logic': return typeof v === 'boolean' ? v : FAIL;
		case 'char': case 'char32': return typeof v === 'string' && v.length <= 2 ? v : FAIL;
		case 'rational': return v instanceof VRational || (typeof v === 'number' && Number.isInteger(v)) ? v : FAIL;
		case 'option': return v instanceof VOption ? v : FAIL;
		case 'array': return Array.isArray(v) ? v : FAIL;
		case 'map': return v instanceof VMap ? v : FAIL;
		case 'tuple': return v instanceof VTuple ? v : FAIL;
		case 'class': {
			if (v instanceof VObject) {
				const cls = v.cls as { info?: ClassInfo; conforms?: (n: string) => boolean };
				if (cls.info) {
					const walk = (info: ClassInfo): boolean => info === vtype.info || info.supers.some(walk);
					return walk(cls.info) ? v : FAIL;
				}
				return cls.conforms?.(vtype.info.name) ? v : FAIL;
			}
			return FAIL;
		}
		case 'enum': return v instanceof VEnumValue && v.enumName === vtype.info.name ? v : FAIL;
		default: return v; // any/unknown/typeParam: erased -> succeed
	}
}

function indexValue(target: Value, index: Value): Value | typeof FAIL {
	if (Array.isArray(target) || typeof target === 'string') {
		const i = index as number;
		if (!Number.isInteger(i) || i < 0 || i >= target.length) {
			return FAIL;
		}
		return Array.isArray(target) ? target[i] : target[i];
	}
	if (target instanceof VMap) {
		return target.get(index);
	}
	if (target instanceof VTuple) {
		const i = index as number;
		if (!Number.isInteger(i) || i < 0 || i >= target.elements.length) {
			return FAIL;
		}
		return target.elements[i];
	}
	return FAIL;
}

type BinaryFn = (l: Value, r: Value) => Value | typeof FAIL;

const floatDivide: BinaryFn = (l, r) => (l as number) / (r as number);

/**
 * Sync-first binary evaluation: the common all-synchronous path runs with
 * no closure allocation at all; promise continuations are only built when
 * an operand actually suspends.
 */
function evalBinary(left: Code, right: Code, env: Env, ctx: Ctx, apply: BinaryFn): unknown {
	const l = left(env, ctx);
	if (isPromise(l)) {
		return l.then((lv) => {
			if (lv === FAIL) {
				return FAIL;
			}
			return chain(right(env, ctx), (rv) =>
				rv === FAIL ? FAIL : apply(lv as Value, rv as Value));
		});
	}
	if (l === FAIL) {
		return FAIL;
	}
	const r = right(env, ctx);
	if (isPromise(r)) {
		return r.then((rv) => (rv === FAIL ? FAIL : apply(l as Value, rv as Value)));
	}
	if (r === FAIL) {
		return FAIL;
	}
	return apply(l as Value, r as Value);
}

/**
 * Compile-time operator selection. When the checker proved both operands
 * numeric (or both strings), returns a monomorphic implementation with no
 * runtime type dispatch; otherwise falls back to the generic applyBinary.
 * Note ints are JS numbers here (documented deviation), so int arithmetic
 * is plain number arithmetic.
 */
function selectBinaryOp(
	op: string,
	leftKind: string | undefined,
	rightKind: string | undefined,
	line: number,
): BinaryFn {
	const isNum = (k: string | undefined) => k === 'int' || k === 'float';
	const bothNum = isNum(leftKind) && isNum(rightKind);
	const bothInt = leftKind === 'int' && rightKind === 'int';
	const bothStr = leftKind === 'string' && rightKind === 'string';
	switch (op) {
		case '+':
			if (bothNum) {
				return (l, r) => (l as number) + (r as number);
			}
			if (bothStr) {
				return (l, r) => (l as string) + (r as string);
			}
			break;
		case '-':
			if (bothNum) {
				return (l, r) => (l as number) - (r as number);
			}
			break;
		case '*':
			if (bothNum) {
				return (l, r) => (l as number) * (r as number);
			}
			break;
		case '/':
			// Fast path for int/int: exact quotients stay ints without
			// allocating a rational. (float-typed division is specialized
			// even earlier, in compileBinary.)
			if (bothInt) {
				return (l, r) => {
					const li = l as number;
					const ri = r as number;
					if (ri === 0) {
						return FAIL;
					}
					if (li % ri === 0) {
						return li / ri;
					}
					const rational = new VRational(li, ri);
					return rational.den === 1 ? rational.num : rational;
				};
			}
			break;
		case '=':
			if (bothNum || bothStr) {
				return (l, r) => (l === r ? l : FAIL);
			}
			break;
		case '<>':
			if (bothNum || bothStr) {
				return (l, r) => (l === r ? FAIL : l);
			}
			break;
		case '<':
			if (bothNum || bothStr) {
				return (l, r) => ((l as number | string) < (r as number | string) ? l : FAIL);
			}
			break;
		case '<=':
			if (bothNum || bothStr) {
				return (l, r) => ((l as number | string) <= (r as number | string) ? l : FAIL);
			}
			break;
		case '>':
			if (bothNum || bothStr) {
				return (l, r) => ((l as number | string) > (r as number | string) ? l : FAIL);
			}
			break;
		case '>=':
			if (bothNum || bothStr) {
				return (l, r) => ((l as number | string) >= (r as number | string) ? l : FAIL);
			}
			break;
	}
	return (l, r) => applyBinary(op, l, r, line);
}

function applyBinary(op: string, l: Value, r: Value, line: number): Value | typeof FAIL {
	switch (op) {
		case '+': {
			if (typeof l === 'number' && typeof r === 'number') {
				return l + r;
			}
			if (typeof l === 'string' && typeof r === 'string') {
				return l + r;
			}
			if (Array.isArray(l) && Array.isArray(r)) {
				return l.concat(r);
			}
			if (l instanceof VMap && r instanceof VMap) {
				const result = l.clone();
				for (const [k, v] of r.pairs()) {
					result.set(k, v);
				}
				return result;
			}
			if (l instanceof VRational || r instanceof VRational) {
				return asRational(l).add(asRational(r));
			}
			if (typeof l === 'string' || typeof r === 'string') {
				return verseToString(l) + verseToString(r);
			}
			break;
		}
		case '-': {
			if (typeof l === 'number' && typeof r === 'number') {
				return l - r;
			}
			if (l instanceof VRational || r instanceof VRational) {
				return asRational(l).sub(asRational(r));
			}
			break;
		}
		case '*': {
			if (typeof l === 'number' && typeof r === 'number') {
				return l * r;
			}
			if (l instanceof VRational || r instanceof VRational) {
				return asRational(l).mul(asRational(r));
			}
			break;
		}
		case '/': {
			if (typeof l === 'number' && typeof r === 'number') {
				if (Number.isInteger(l) && Number.isInteger(r)) {
					if (r === 0) {
						return FAIL;
					}
					const rational = new VRational(l, r);
					return rational.den === 1 ? rational.num : rational;
				}
				return l / r;
			}
			if (l instanceof VRational || r instanceof VRational) {
				return asRational(l).div(asRational(r));
			}
			break;
		}
		case '=':
			return verseEquals(l, r) ? l : FAIL;
		case '<>':
			return verseEquals(l, r) ? FAIL : l;
		case '<': case '<=': case '>': case '>=': {
			const cmp = compareValues(l, r);
			if (cmp === null) {
				return FAIL;
			}
			const ok =
				(op === '<' && cmp < 0) || (op === '<=' && cmp <= 0) ||
				(op === '>' && cmp > 0) || (op === '>=' && cmp >= 0);
			return ok ? l : FAIL;
		}
	}
	throw new VerseRuntimeError(
		`Operator '${op}' cannot combine ${verseToString(l) || 'void'} and ${verseToString(r) || 'void'}`,
		line,
	);
}

function compareValues(l: Value, r: Value): number | null {
	if (typeof l === 'number' && typeof r === 'number') {
		return l < r ? -1 : l > r ? 1 : 0;
	}
	if (l instanceof VRational || r instanceof VRational) {
		if ((typeof l === 'number' || l instanceof VRational) && (typeof r === 'number' || r instanceof VRational)) {
			return asRational(l).compare(asRational(r));
		}
		return null;
	}
	if (typeof l === 'string' && typeof r === 'string') {
		return l < r ? -1 : l > r ? 1 : 0;
	}
	if (l instanceof VEnumValue && r instanceof VEnumValue && l.enumName === r.enumName) {
		return l.ordinal - r.ordinal;
	}
	return null;
}

function resolveMethod(method: VFunctionValue, ctx: Ctx): VFunctionValue {
	const holder = method as VFunctionValue & {
		__make?: (env: Env) => VFunctionValue;
		__resolved?: VFunctionValue;
	};
	if (holder.__resolved) {
		return holder.__resolved;
	}
	if (holder.__make) {
		const rootEnv: Env = { slots: ctx.shared.globals, parent: null, self: undefined };
		const resolved = holder.__make(rootEnv);
		holder.__resolved = resolved;
		return resolved;
	}
	return method;
}

function objectMember(obj: VObject, name: string, ctx: Ctx): Value {
	if (obj.fields.has(name)) {
		return obj.fields.get(name);
	}
	const cls = obj.cls as RuntimeClass;
	if (cls instanceof RuntimeClass) {
		const method = cls.methods.get(name);
		if (method) {
			return resolveMethod(method, ctx).bind(obj);
		}
	}
	const extension = ctx.shared.extensionMethods.get(name);
	if (extension) {
		return extension.bind(obj);
	}
	throw new VerseRuntimeError(`'${cls.name ?? 'object'}' has no member '${name}'`);
}

function memberValue(target: Value, name: string, ctx: Ctx): Value | typeof FAIL {
	if (target instanceof VObject) {
		return objectMember(target, name, ctx);
	}
	if (Array.isArray(target) || typeof target === 'string') {
		if (name === 'Length') {
			return target.length;
		}
		if (name === 'Slice') {
			return new VNativeFunction('Slice', (args) => {
				const start = args[0] as number;
				const end = args.length > 1 ? (args[1] as number) : target.length;
				if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > target.length || start > end) {
					return FAIL;
				}
				return target.slice(start, end);
			});
		}
		if (name === 'Find') {
			return new VNativeFunction('Find', (args) => {
				if (Array.isArray(target)) {
					const idx = target.findIndex((v) => verseEquals(v, args[0]));
					return idx >= 0 ? idx : FAIL;
				}
				const idx = target.indexOf(args[0] as string);
				return idx >= 0 ? idx : FAIL;
			});
		}
	}
	if (target instanceof VMap) {
		if (name === 'Length') {
			return target.size;
		}
	}
	// Native methods on engine values (tasks, events, ...) resolve through
	// the bindings registry so extras and embedder modules dispatch the
	// same way as the standard library.
	const nativeMethod = ctx.shared.natives?.resolveValueMethod(target, name);
	if (nativeMethod) {
		return new VNativeFunction(name, (args, rawCtx) =>
			nativeMethod(target, args as Value[], rawCtx as Ctx));
	}
	const extension = ctx.shared.extensionMethods.get(name);
	if (extension) {
		return extension.bind(target);
	}
	throw new VerseRuntimeError(`Value has no member '${name}'`);
}

function dispatchCall(
	callee: Value,
	args: Value[],
	named: Map<string, Value> | undefined,
	ctx: Ctx,
	failable: boolean,
	line: number,
): unknown {
	if (callee instanceof VFunctionValue) {
		return (callee.invoke as (self: Value, args: Value[], ctx: Ctx, named?: Map<string, Value>) => unknown)(
			callee.self, args, ctx, named,
		);
	}
	if (callee instanceof VNativeFunction) {
		return callee.invoke(args, ctx);
	}
	if (callee instanceof VTypeValue) {
		if (failable) {
			return callee.cast(args[0]);
		}
		throw new VerseRuntimeError(`'${callee.name}' is a type; use ${callee.name}[...] to cast or ${callee.name}{...} to construct`, line);
	}
	if (Array.isArray(callee) || typeof callee === 'string' || callee instanceof VMap || callee instanceof VTuple) {
		return indexValue(callee, args[0]);
	}
	throw new VerseRuntimeError('Value is not callable', line);
}

function normalizeIterable(value: Value, line: number): Value[] | [Value, Value][] {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value === 'string') {
		return value.split('');
	}
	if (value instanceof VMap) {
		return [...value.pairs()];
	}
	// Single value binding form: for (X := expr).
	if (value !== undefined) {
		return [value];
	}
	throw new VerseRuntimeError('for expects an array, map, string, or range', line);
}

function runLoop(body: Code, condition: Code | null, env: Env, ctx: Ctx): unknown {
	let backedges = 0;

	const step = (): unknown => {
		for (;;) {
			backedges += 1;
			if (backedges % YIELD_EVERY_BACKEDGES === 0) {
				ctx.task.throwIfCancelled();
				// Yield the event loop so Stop stays responsive in hot loops.
				return new Promise((resolve) => setTimeout(resolve, 0)).then(() => stepAsync());
			}
			if (condition) {
				const c = condition(env, ctx);
				if (isPromise(c)) {
					return c.then((cv) => (cv === FAIL ? undefined : chain(body(env, ctx), () => stepAsync())));
				}
				if (c === FAIL) {
					return undefined;
				}
			}
			const r = body(env, ctx);
			if (isPromise(r)) {
				return r.then(() => stepAsync());
			}
		}
	};
	const stepAsync = async (): Promise<unknown> => {
		for (;;) {
			backedges += 1;
			if (backedges % YIELD_EVERY_BACKEDGES === 0) {
				ctx.task.throwIfCancelled();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			if (condition) {
				const c = await condition(env, ctx);
				if (c === FAIL) {
					return undefined;
				}
			}
			const r = body(env, ctx);
			if (isPromise(r)) {
				await r;
			}
		}
	};

	try {
		const r = step();
		if (isPromise(r)) {
			return r.then(
				(v) => v,
				(error) => {
					if (error instanceof BreakSignal) {
						return undefined;
					}
					throw error;
				},
			);
		}
		return r;
	} catch (error) {
		if (error instanceof BreakSignal) {
			return undefined;
		}
		throw error;
	}
}

function persistIfNeeded(ctx: Ctx, value: Value): void {
	const map = value as VMap & { persistName?: string };
	if (!(value instanceof VMap) || !map.persistName || !ctx.shared.persistence) {
		return;
	}
	const key = ctx.shared.persistenceKeys.get(map.persistName);
	if (!key) {
		return;
	}
	const serialized = JSON.stringify([...map.pairs()].map(([k, v]) => [toJson(k), toJson(v)]));
	ctx.shared.persistence.store(key, serialized);
}

// --- JSON persistence encoding ---

export function toJson(v: Value): unknown {
	if (v === undefined) {
		return { $: 'void' };
	}
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
		return v;
	}
	if (v instanceof VRational) {
		return { $: 'rational', n: v.num, d: v.den };
	}
	if (Array.isArray(v)) {
		return { $: 'array', items: v.map(toJson) };
	}
	if (v instanceof VTuple) {
		return { $: 'tuple', items: v.elements.map(toJson) };
	}
	if (v instanceof VOption) {
		return v.isSet ? { $: 'option', value: toJson(v.value) } : { $: 'option' };
	}
	if (v instanceof VMap) {
		return { $: 'map', entries: [...v.pairs()].map(([k, val]) => [toJson(k), toJson(val)]) };
	}
	if (v instanceof VEnumValue) {
		return { $: 'enum', enum: v.enumName, name: v.name, ord: v.ordinal };
	}
	if (v instanceof VObject) {
		// Session-scoped identities (players) serialize as a stable tag.
		if (v.persistKey) {
			return { $: 'opaque', repr: v.persistKey, cls: v.cls.name };
		}
		return {
			$: 'object',
			cls: v.cls.name,
			isStruct: v.cls.isStruct,
			fields: Object.fromEntries([...v.fields.entries()].map(([k, val]) => [k, toJson(val)])),
		};
	}
	return { $: 'opaque', repr: canonicalKey(v) };
}

export function reviveJson(raw: unknown): Value {
	if (raw === null) {
		return undefined;
	}
	if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') {
		return raw;
	}
	const obj = raw as Record<string, unknown>;
	switch (obj.$) {
		case 'void': return undefined;
		case 'rational': return new VRational(obj.n as number, obj.d as number);
		case 'array': return (obj.items as unknown[]).map(reviveJson);
		case 'tuple': return new VTuple((obj.items as unknown[]).map(reviveJson));
		case 'option':
			return 'value' in obj ? VOption.someAllowingUndefined(reviveJson(obj.value)) : VOption.EMPTY;
		case 'map': {
			const map = new VMap();
			for (const [k, v] of obj.entries as [unknown, unknown][]) {
				map.set(reviveJson(k), reviveJson(v));
			}
			return map;
		}
		case 'enum':
			return new VEnumValue(obj.enum as string, obj.name as string, (obj.ord as number) ?? 0);
		case 'object': {
			const fields = new Map<string, Value>();
			for (const [k, v] of Object.entries(obj.fields as Record<string, unknown>)) {
				fields.set(k, reviveJson(v));
			}
			const cls = {
				name: obj.cls as string,
				isStruct: !!obj.isStruct,
				conforms: (n: string) => n === obj.cls,
			};
			return obj.isStruct ? new VStruct(cls, fields) : new VObject(cls, fields);
		}
		case 'opaque': {
			// Recreate a placeholder carrying the stable identity so map
			// lookups by the live session object still match.
			const name = (obj.cls as string) ?? 'opaque';
			const placeholder = new VObject(
				{ name, isStruct: false, conforms: (n: string) => n === name },
				new Map(),
			);
			placeholder.persistKey = obj.repr as string;
			return placeholder;
		}
		default:
			return undefined;
	}
}
