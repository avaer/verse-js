// host.ts
// The embedding entry point: a VerseHost owns a bindings registry and
// provides compile / run / execute / docs / analyze over it. Hosts are
// isolated — two hosts with different modules never share bindings — and
// the full pipeline is lex -> parse -> check -> compile-to-closures -> run.

import { lex, VerseSyntaxError } from './frontend/lexer';
import { parseVerseTolerant } from './frontend/parser';
import { Program } from './frontend/ast';
import { checkWorkspace, CheckResult, NativeCatalog, WorkspaceFile } from './sema/checker';
import { SourceFsLike, toSourceFs } from './vfs';
import { Diagnostic } from './sema/diagnostics';
import {
	compileProgram, CompiledProgram, toJson,
} from './runtime/compile-closures';
import { Ctx, DebugHooks, OutputLevel, PersistenceAdapter, SharedCtx } from './runtime/context';
import { NativeModuleDef, NativeRegistry } from './bindings/registry';
import { coreModules } from './stdlib/index';
import { Clock, Scheduler } from './runtime/scheduler';
import { VMap } from './runtime/values';
import {
	buildSymbolIndex, generateDocs, getModulePaths, IndexedSymbolDoc, ModuleDoc,
} from './docs';
import {
	analysisFromOutcome, SourceAnalysis, WorkspaceAnalysis,
	workspaceAnalysisFromOutcome,
} from './analysis';

export { VerseRunCancelled, VerseRuntimeError, VerseTaskCancelled } from './runtime/failure';
export type { Diagnostic } from './sema/diagnostics';

/** Editor-marker-shaped diagnostic (1-based lines/columns). */
export interface IdeDiagnostic {
	message: string;
	severity: 'error' | 'warning';
	code?: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	/** Workspace file the diagnostic belongs to (multi-file compiles). */
	file?: string;
}

/** A successful compile: parsed file(s) + checker results. */
export interface CompileSuccess {
	ok: true;
	/** The (entry) program — for workspaces, the first file's program. */
	program: Program;
	/** All parsed workspace files (single-element for `compile`). */
	files: WorkspaceFile[];
	check: CheckResult;
	/** Warnings (and any non-fatal errors when tolerant). */
	diagnostics: IdeDiagnostic[];
}

export interface CompileFailure {
	ok: false;
	diagnostics: IdeDiagnostic[];
}

export type CompileOutcome = CompileSuccess | CompileFailure;

function toIdeDiagnostic(d: Diagnostic): IdeDiagnostic {
	return {
		message: d.message,
		severity: d.severity,
		code: d.code,
		startLine: d.span?.start.line ?? 1,
		startColumn: d.span?.start.col ?? 1,
		endLine: d.span?.end.line ?? d.span?.start.line ?? 1,
		endColumn: d.span
			? Math.max(d.span.end.col, d.span.start.col + 1)
			: 200,
		file: d.file,
	};
}

function syntaxToIdeDiagnostic(error: VerseSyntaxError, file?: string): IdeDiagnostic {
	const end = error.endPos ?? error.pos;
	return {
		message: `Syntax error: ${error.message}`,
		severity: 'error',
		startLine: error.pos.line,
		startColumn: error.pos.col,
		endLine: end.line,
		endColumn: end === error.pos ? error.pos.col + 1 : end.col,
		file,
	};
}

/** Tokenizes for editors/tools; returns [] on lex errors. */
export function tryLex(source: string) {
	try {
		return lex(source);
	} catch {
		return [];
	}
}

/** Options for {@link VerseHost.run} and {@link VerseHost.execute}. */
export interface RunOptions {
	/** Receives program output (stdout), runtime errors, and system notes. */
	onOutput?: (level: OutputLevel, text: string) => void;
	/** Debugger hooks (breakpoints/stepping); forces a debug build. */
	debug?: DebugHooks | null;
	/** Storage for `<persistable>` weak_maps; overrides the host default. */
	persistence?: PersistenceAdapter | null;
	/** Simulation clock; defaults to a real-time clock. */
	clock?: Clock;
	/** Random source for /Verse.org/Random; defaults to Math.random. */
	rng?: () => number;
	/** Backedges allowed in a synchronous stretch before erroring. */
	loopBudget?: number;
	/**
	 * Workspace entry file: only this file's top-level statements and
	 * entry-point classes execute (other files act as libraries). Omit to
	 * run every file, which is the single-file behavior.
	 */
	entry?: string;
}

/** A running (or finished) Verse program. */
export interface VerseRun {
	/** Resolves when the program (incl. spawned tasks it awaits) finishes. */
	done: Promise<void>;
	/** Stops the run: cancels all tasks and unwinds. */
	stop(): void;
	scheduler: Scheduler;
	ctx: Ctx;
}

/** Result of {@link VerseHost.execute}. */
export interface ExecuteResult {
	/** stdout lines, in order. */
	output: string[];
	/** Compile errors (strict) or runtime error messages. */
	errors: string[];
	diagnostics: IdeDiagnostic[];
}

/** Options for {@link createHost}. */
export interface HostOptions {
	/**
	 * Additional native modules beyond the core standard library, e.g.
	 * `uefnModules` from `verse-js/extras/uefn` or your own `defineModule`
	 * results.
	 */
	modules?: NativeModuleDef[];
	/** Default persistence adapter for runs (overridable per run). */
	persistence?: PersistenceAdapter | null;
	/** Set false to omit the /Verse.org standard library (rarely wanted). */
	includeCore?: boolean;
}

/**
 * Starts a compiled program on a fresh scheduler. Low-level building block
 * of {@link VerseHost.run}, exposed for embedders that manage compiled
 * programs themselves (e.g. compile once, run many times).
 */
export function startRun(
	compiled: CompiledProgram,
	options: RunOptions = {},
): VerseRun {
	const scheduler = new Scheduler(options.clock);
	const shared: SharedCtx = {
		scheduler,
		out: options.onOutput ?? (() => {}),
		rng: options.rng ?? Math.random,
		globals: [],
		debug: options.debug ?? null,
		persistence: options.persistence ?? null,
		persistenceKeys: new Map(),
		natives: compiled.registry,
		extensionMethods: new Map(),
		loopBudget: options.loopBudget ?? 100_000_000,
		profile: (label, seconds) => {
			(options.onOutput ?? (() => {}))('system', `[profile] ${label}: ${seconds.toFixed(6)}s`);
		},
	};
	const ctx = new Ctx(shared, scheduler.rootTask);

	const done = compiled.run(ctx, options.entry).finally(() => {
		flushPersistence(shared);
	});

	return {
		done,
		stop: () => scheduler.cancelRun(),
		scheduler,
		ctx,
	};
}

/** Writes persistable weak_maps back to the adapter at end of run. */
function flushPersistence(shared: SharedCtx): void {
	if (!shared.persistence) {
		return;
	}
	for (const [name, storageKey] of shared.persistenceKeys) {
		const value = findPersistentMap(shared, name);
		if (value instanceof VMap) {
			const pairs = [...value.entries.values()].map(([k, v]) => [toJson(k), toJson(v)]);
			shared.persistence.store(storageKey, JSON.stringify(pairs));
		}
	}
}

function findPersistentMap(shared: SharedCtx, name: string): unknown {
	for (const g of shared.globals) {
		if (g instanceof VMap && (g as VMap & { persistName?: string }).persistName === name) {
			return g;
		}
	}
	return null;
}

/**
 * An isolated Verse environment: a bindings registry plus the full
 * compile/run pipeline and IDE services over it. Create with
 * {@link createHost}.
 */
export class VerseHost {
	/** The host's bindings. Mutating after first compile is not supported. */
	readonly registry: NativeRegistry;
	private readonly defaultPersistence: PersistenceAdapter | null;
	private catalogCache: NativeCatalog | null = null;
	private docsCache: ModuleDoc[] | null = null;
	private symbolIndexCache: Map<string, IndexedSymbolDoc> | null = null;

	constructor(options: HostOptions = {}) {
		this.registry = new NativeRegistry();
		if (options.includeCore !== false) {
			this.registry.addAll(coreModules);
		}
		if (options.modules) {
			this.registry.addAll(options.modules);
		}
		this.defaultPersistence = options.persistence ?? null;
	}

	private catalog(): NativeCatalog {
		if (!this.catalogCache) {
			this.catalogCache = this.registry.toCatalog();
		}
		return this.catalogCache;
	}

	/**
	 * Compiles Verse source through the front end and checker. Type/effect
	 * errors are reported but do not block execution (`ok` stays true unless
	 * parsing fails or `strict` is set); the checker degrades unknown types
	 * gracefully, matching how an IDE wants live diagnostics while typing.
	 */
	compile(source: string, options: { strict?: boolean } = {}): CompileOutcome {
		return this.compileWorkspace({ 'main.verse': source }, options);
	}

	/**
	 * Compiles every `.verse` file of a workspace against one shared module
	 * scope, so files can reference each other's definitions in any order.
	 * Pass a {@link SourceFileSystem} or a plain path->source object.
	 * Diagnostics carry the file they belong to. Run the result with
	 * `run(outcome, { entry: 'main.verse' })` to execute one file's
	 * top-level statements and entry points with the rest as libraries.
	 */
	compileWorkspace(fs: SourceFsLike, options: { strict?: boolean } = {}): CompileOutcome {
		const sourceFs = toSourceFs(fs);
		const files: WorkspaceFile[] = [];
		const syntaxDiagnostics: IdeDiagnostic[] = [];
		for (const file of sourceFs.listFiles()) {
			const source = sourceFs.readFile(file);
			if (source === null) {
				continue;
			}
			// Error-recovering parse: syntax errors are collected per
			// top-level statement so diagnostics survive a typo mid-file.
			const { program, errors } = parseVerseTolerant(source);
			if (errors.length > 0) {
				syntaxDiagnostics.push(...errors.map((e) => syntaxToIdeDiagnostic(e, file)));
			} else {
				files.push({ file, program });
			}
		}
		if (syntaxDiagnostics.length > 0) {
			return { ok: false, diagnostics: syntaxDiagnostics };
		}
		if (files.length === 0) {
			return { ok: false, diagnostics: [] };
		}

		const check = checkWorkspace(files, this.catalog());
		const diagnostics = check.diagnostics.map(toIdeDiagnostic);
		if (options.strict && diagnostics.some((d) => d.severity === 'error')) {
			return { ok: false, diagnostics };
		}
		return { ok: true, program: files[0].program, files, check, diagnostics };
	}

	/**
	 * Closure-compiles a checked program. Useful to compile once and run
	 * many times via {@link startRun}; {@link VerseHost.run} does this
	 * implicitly.
	 */
	prepare(outcome: CompileSuccess, options: { debug?: boolean } = {}): CompiledProgram {
		return compileProgram(
			outcome.files,
			this.registry,
			outcome.check.globalSlotCount,
			outcome.check.entryClasses,
			{ debug: options.debug ?? false },
		);
	}

	/**
	 * Runs a compiled outcome (or an already-prepared program). Passing
	 * `debug` hooks produces a debug build with per-statement hooks.
	 */
	run(program: CompileSuccess | CompiledProgram, options: RunOptions = {}): VerseRun {
		const compiled = 'ok' in program
			? this.prepare(program, { debug: !!options.debug })
			: program;
		return startRun(compiled, {
			...options,
			persistence: options.persistence !== undefined
				? options.persistence
				: this.defaultPersistence,
		});
	}

	/**
	 * Convenience: compile (strict) + run to completion, collecting output
	 * lines and errors.
	 */
	async execute(source: string, options: RunOptions = {}): Promise<ExecuteResult> {
		const output: string[] = [];
		const errors: string[] = [];
		const outcome = this.compile(source, { strict: true });
		if (!outcome.ok) {
			return {
				output,
				errors: outcome.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
				diagnostics: outcome.diagnostics,
			};
		}
		const run = this.run(outcome, {
			...options,
			onOutput: (level, text) => {
				if (level === 'error') {
					errors.push(text);
				} else if (level === 'stdout') {
					output.push(text);
				}
				options.onOutput?.(level, text);
			},
		});
		try {
			await run.done;
		} catch (error) {
			errors.push((error as Error).message);
		}
		return { output, errors, diagnostics: outcome.diagnostics };
	}

	/**
	 * Convenience: compile a workspace (strict) + run one entry file to
	 * completion, collecting output lines and errors.
	 */
	async executeWorkspace(
		fs: SourceFsLike,
		options: RunOptions & { entry?: string } = {},
	): Promise<ExecuteResult> {
		const output: string[] = [];
		const errors: string[] = [];
		const outcome = this.compileWorkspace(fs, { strict: true });
		if (!outcome.ok) {
			return {
				output,
				errors: outcome.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
				diagnostics: outcome.diagnostics,
			};
		}
		const run = this.run(outcome, {
			...options,
			onOutput: (level, text) => {
				if (level === 'error') {
					errors.push(text);
				} else if (level === 'stdout') {
					output.push(text);
				}
				options.onOutput?.(level, text);
			},
		});
		try {
			await run.done;
		} catch (error) {
			errors.push((error as Error).message);
		}
		return { output, errors, diagnostics: outcome.diagnostics };
	}

	/** Documentation for every module registered on this host. */
	docs(): ModuleDoc[] {
		if (!this.docsCache) {
			this.docsCache = generateDocs(this.registry);
		}
		return this.docsCache;
	}

	/** name -> symbol doc index over {@link VerseHost.docs}. */
	symbolIndex(): Map<string, IndexedSymbolDoc> {
		if (!this.symbolIndexCache) {
			this.symbolIndexCache = buildSymbolIndex(this.docs());
		}
		return this.symbolIndexCache;
	}

	/** Sorted module paths (for `using { ... }` completions). */
	modulePaths(): string[] {
		return getModulePaths(this.docs());
	}

	/**
	 * Compiles source for IDE queries (hover/definition/completions via
	 * `hoverAt`, `definitionAt`, `completionsAt`). Cheap enough to run per
	 * keystroke.
	 */
	analyze(source: string): SourceAnalysis {
		return analysisFromOutcome(this.compile(source));
	}

	/**
	 * Compiles a whole workspace for IDE queries. Each file's analysis
	 * shares the workspace module scope, so hover/definition/completions
	 * resolve names defined in other files (definitions carry their file).
	 */
	analyzeWorkspace(fs: SourceFsLike): WorkspaceAnalysis {
		return workspaceAnalysisFromOutcome(this.compileWorkspace(fs));
	}
}

/**
 * Creates an isolated Verse host.
 *
 * ```ts
 * import { createHost } from 'verse-js';
 * import { uefnModules } from 'verse-js/extras/uefn';
 *
 * const host = createHost({ modules: uefnModules });
 * const { output } = await host.execute('Print("hi")');
 * ```
 */
export function createHost(options: HostOptions = {}): VerseHost {
	return new VerseHost(options);
}

export { compileProgram } from './runtime/compile-closures';
export type { CompiledProgram } from './runtime/compile-closures';
