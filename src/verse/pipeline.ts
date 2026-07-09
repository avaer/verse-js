// pipeline.ts
// Single entry point for the new Verse implementation: lex -> parse ->
// check -> compile-to-closures -> run. Produces Monaco-friendly
// diagnostics and a runner with pluggable output/persistence/debug hooks.

import { lex, VerseSyntaxError } from './frontend/lexer';
import { parseVerseTolerant } from './frontend/parser';
import { Program } from './frontend/ast';
import { checkProgram, CheckResult } from './sema/checker';
import { Diagnostic } from './sema/diagnostics';
import {
	compileProgram, CompiledProgram, toJson,
} from './runtime/compile-closures';
import { Ctx, DebugHooks, OutputLevel, PersistenceAdapter, SharedCtx } from './runtime/context';
import { buildNativeRegistry } from './runtime/natives/core';
import { NativeRegistry } from './runtime/natives/registry';
import { Clock, Scheduler } from './runtime/scheduler';
import { VMap } from './runtime/values';

export { VerseRunCancelled, VerseRuntimeError, VerseTaskCancelled } from './runtime/failure';
export type { Diagnostic } from './sema/diagnostics';

/** Monaco-marker-shaped diagnostic (1-based lines/columns). */
export interface IdeDiagnostic {
	message: string;
	severity: 'error' | 'warning';
	code?: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface CompileSuccess {
	ok: true;
	program: Program;
	check: CheckResult;
	/** Warnings (and any non-fatal errors when tolerant). */
	diagnostics: IdeDiagnostic[];
}

export interface CompileFailure {
	ok: false;
	diagnostics: IdeDiagnostic[];
}

export type CompileOutcome = CompileSuccess | CompileFailure;

const sharedRegistry = buildNativeRegistry();

export function getNativeRegistry(): NativeRegistry {
	return sharedRegistry;
}

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
	};
}

function syntaxToIdeDiagnostic(error: VerseSyntaxError): IdeDiagnostic {
	const end = error.endPos ?? error.pos;
	return {
		message: `Syntax error: ${error.message}`,
		severity: 'error',
		startLine: error.pos.line,
		startColumn: error.pos.col,
		endLine: end.line,
		endColumn: end === error.pos ? error.pos.col + 1 : end.col,
	};
}

/**
 * Compiles Verse source through the front end and checker. Type/effect
 * errors are reported but do not block execution (`ok` stays true unless
 * parsing fails or `strict` is set); the checker degrades unknown types
 * gracefully, matching how the IDE wants live diagnostics while typing.
 */
export function compileVerse(source: string, options: { strict?: boolean } = {}): CompileOutcome {
	// Error-recovering parse: syntax errors are collected per top-level
	// statement so live diagnostics survive a typo mid-file.
	const { program, errors } = parseVerseTolerant(source);
	if (errors.length > 0) {
		return { ok: false, diagnostics: errors.map(syntaxToIdeDiagnostic) };
	}

	const check = checkProgram(program, sharedRegistry.toCatalog());
	const diagnostics = check.diagnostics.map(toIdeDiagnostic);
	if (options.strict && diagnostics.some((d) => d.severity === 'error')) {
		return { ok: false, diagnostics };
	}
	return { ok: true, program, check, diagnostics };
}

/** Tokenizes for editors/tools; returns [] on lex errors. */
export function tryLex(source: string) {
	try {
		return lex(source);
	} catch {
		return [];
	}
}

export interface RunOptions {
	onOutput?: (level: OutputLevel, text: string) => void;
	debug?: DebugHooks | null;
	persistence?: PersistenceAdapter | null;
	clock?: Clock;
	rng?: () => number;
	/** Backedges allowed in a synchronous stretch before erroring. */
	loopBudget?: number;
}

export interface VerseRun {
	/** Resolves when the program (incl. spawned tasks it awaits) finishes. */
	done: Promise<void>;
	/** Stops the run: cancels all tasks and unwinds. */
	stop(): void;
	scheduler: Scheduler;
	ctx: Ctx;
}

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
		extensionMethods: new Map(),
		loopBudget: options.loopBudget ?? 100_000_000,
		profile: (label, seconds) => {
			(options.onOutput ?? (() => {}))('system', `[profile] ${label}: ${seconds.toFixed(6)}s`);
		},
	};
	const ctx = new Ctx(shared, scheduler.rootTask);

	const done = compiled.run(ctx).finally(() => {
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
 * Convenience: compile + run to completion, collecting output lines.
 * Used by tests and simple embedding scenarios.
 */
export async function runVerse(
	source: string,
	options: RunOptions = {},
): Promise<{ output: string[]; errors: string[]; diagnostics: IdeDiagnostic[] }> {
	const output: string[] = [];
	const errors: string[] = [];
	const outcome = compileVerse(source, { strict: true });
	if (!outcome.ok) {
		return {
			output,
			errors: outcome.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
			diagnostics: outcome.diagnostics,
		};
	}
	const compiled = compileProgram(
		outcome.program,
		sharedRegistry,
		outcome.check.globalSlotCount,
		outcome.check.deviceClasses,
		{ debug: false },
	);
	const run = startRun(compiled, {
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

export { compileProgram } from './runtime/compile-closures';
export type { CompiledProgram } from './runtime/compile-closures';
