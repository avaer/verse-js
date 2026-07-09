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
	variables: { name: string; value: string }[];
	callStack: { name: string; line: number | null }[];
	tasks: { id: number; name: string; state: TaskState }[];
}

export interface DebugSessionOptions {
	debugEnabled: boolean;
	breakpoints?: number[];
	onPaused?: (info: PausedInfo) => void;
	onResumed?: () => void;
}

export class DebugSession implements DebugHooks {
	debugEnabled: boolean;
	private breakpoints: Set<number>;
	private onPaused: ((info: PausedInfo) => void) | null;
	private onResumed: (() => void) | null;

	private stepMode: 'into' | 'over' | 'out' | null = null;
	private stepDepth = 0;
	private pausedDepth = 0;
	private statementCount = 0;
	private resumeResolve: (() => void) | null = null;
	paused = false;

	/** Call stack of user functions ((top level) is implicit). */
	private callStack: { name: string; line: number | null }[] = [];

	constructor(options: DebugSessionOptions) {
		this.debugEnabled = options.debugEnabled;
		this.breakpoints = new Set(options.breakpoints ?? []);
		this.onPaused = options.onPaused ?? null;
		this.onResumed = options.onResumed ?? null;
	}

	setBreakpoints(lines: number[]): void {
		this.breakpoints = new Set(lines ?? []);
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

	onEnterFunction(name: string, line: number | null): void {
		this.callStack.push({ name, line });
	}

	onLeaveFunction(): void {
		this.callStack.pop();
	}

	onStatement(line: number | null, ctx: Ctx, env: unknown): Promise<void> | void {
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
		} else if (line !== null && this.breakpoints.has(line)) {
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
			variables: snapshotVariables(env as Env | null),
			callStack: [
				...[...this.callStack].reverse(),
				{ name: '(top level)', line: null },
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
