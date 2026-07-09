// DebugSession.ts
// Debug hooks for the closure-compiled runtime. The compiler (in debug
// mode) calls onStatement before every statement with the current line and
// frame; this class implements breakpoints, step over/into/out via
// call-depth bookkeeping, pause/resume, and variable/call-stack snapshots
// for the IDE's DebugPanel. Cancellation is handled by the scheduler
// (Scheduler.cancelRun), not here.

import { Ctx, DebugHooks } from '../runtime/context';
import { Env } from '../runtime/compile-closures';
import { TaskState } from '../runtime/scheduler';
import { Value, verseToDiagnostic } from '../runtime/values';

const YIELD_EVERY_N_STATEMENTS = 250;

export interface PausedInfo {
	line: number | null;
	/** Workspace file paused in (null for single-file runs pre-tagging). */
	file: string | null;
	variables: { name: string; value: string }[];
	callStack: { name: string; line: number | null; file: string | null }[];
	tasks: { id: number; name: string; state: TaskState }[];
}

/**
 * Breakpoints: either a plain line array (matches those lines in any file
 * — the single-file form) or a per-file map of line arrays.
 */
export type BreakpointSpec = number[] | Record<string, number[]>;

export interface DebugSessionOptions {
	debugEnabled: boolean;
	breakpoints?: BreakpointSpec;
	onPaused?: (info: PausedInfo) => void;
	onResumed?: () => void;
}

export class DebugSession implements DebugHooks {
	debugEnabled: boolean;
	private anyFileBreakpoints: Set<number> = new Set();
	private fileBreakpoints: Map<string, Set<number>> = new Map();
	private onPaused: ((info: PausedInfo) => void) | null;
	private onResumed: (() => void) | null;

	private stepMode: 'into' | 'over' | 'out' | null = null;
	private stepDepth = 0;
	private pausedDepth = 0;
	private statementCount = 0;
	private resumeResolve: (() => void) | null = null;
	paused = false;

	/** Call stack of user functions ((top level) is implicit). */
	private callStack: { name: string; line: number | null; file: string | null }[] = [];

	constructor(options: DebugSessionOptions) {
		this.debugEnabled = options.debugEnabled;
		this.setBreakpoints(options.breakpoints ?? []);
		this.onPaused = options.onPaused ?? null;
		this.onResumed = options.onResumed ?? null;
	}

	setBreakpoints(spec: BreakpointSpec): void {
		this.anyFileBreakpoints = new Set();
		this.fileBreakpoints = new Map();
		if (Array.isArray(spec)) {
			this.anyFileBreakpoints = new Set(spec);
			return;
		}
		for (const [file, lines] of Object.entries(spec ?? {})) {
			this.fileBreakpoints.set(file, new Set(lines));
		}
	}

	private hasBreakpoint(line: number, file: string | null): boolean {
		if (this.anyFileBreakpoints.has(line)) {
			return true;
		}
		if (file !== null) {
			const lines = this.fileBreakpoints.get(file);
			return !!lines && lines.has(line);
		}
		return false;
	}

	resume(): void {
		this.stepMode = null;
		this.wake();
	}

	stepInto(): void {
		this.stepMode = 'into';
		this.wake();
	}

	stepOver(): void {
		this.stepMode = 'over';
		this.stepDepth = this.pausedDepth;
		this.wake();
	}

	stepOut(): void {
		this.stepMode = 'out';
		this.stepDepth = this.pausedDepth;
		this.wake();
	}

	/** Wakes a paused session so cancellation can unwind. */
	wake(): void {
		if (this.resumeResolve) {
			const resolve = this.resumeResolve;
			this.resumeResolve = null;
			resolve();
		}
	}

	onEnterFunction(name: string, line: number | null, file: string | null): void {
		this.callStack.push({ name, line, file });
	}

	onLeaveFunction(): void {
		this.callStack.pop();
	}

	onStatement(line: number | null, file: string | null, ctx: Ctx, env: unknown): Promise<void> | void {
		ctx.task.throwIfCancelled();

		this.statementCount += 1;
		const needsYield = this.statementCount % YIELD_EVERY_N_STATEMENTS === 0;

		if (!this.debugEnabled) {
			if (needsYield) {
				return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
					ctx.task.throwIfCancelled();
				});
			}
			return;
		}

		const depth = this.callStack.length;
		let shouldPause = false;
		if (this.stepMode === 'into') {
			shouldPause = true;
		} else if (this.stepMode === 'over' && depth <= this.stepDepth) {
			shouldPause = true;
		} else if (this.stepMode === 'out' && depth < this.stepDepth) {
			shouldPause = true;
		} else if (line !== null && this.hasBreakpoint(line, file)) {
			shouldPause = true;
		}

		if (!shouldPause) {
			if (needsYield) {
				return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
					ctx.task.throwIfCancelled();
				});
			}
			return;
		}

		this.stepMode = null;
		this.paused = true;
		this.pausedDepth = depth;

		this.onPaused?.({
			line,
			file,
			variables: snapshotVariables(env as Env | null),
			callStack: [
				...[...this.callStack].reverse(),
				{ name: '(top level)', line: null, file: null },
			],
			tasks: ctx.shared.scheduler.taskList(),
		});

		return new Promise<void>((resolve) => {
			this.resumeResolve = resolve;
		}).then(() => {
			this.paused = false;
			this.onResumed?.();
			ctx.task.throwIfCancelled();
		});
	}
}

/** Renders the current frame (+ enclosing frames) for the variables view. */
function snapshotVariables(env: Env | null): { name: string; value: string }[] {
	const seen = new Set<string>();
	const result: { name: string; value: string }[] = [];
	let depth = 0;
	while (env && depth < 8) {
		const names = env.names;
		if (names) {
			for (let i = 0; i < names.length; i++) {
				const name = names[i];
				if (!name || seen.has(name) || env.slots[i] === undefined) {
					continue;
				}
				seen.add(name);
				result.push({ name, value: safeToString(env.slots[i]) });
			}
		}
		env = env.parent;
		depth += 1;
	}
	return result;
}

function safeToString(v: Value): string {
	try {
		return verseToDiagnostic(v);
	} catch {
		return '<unprintable>';
	}
}
