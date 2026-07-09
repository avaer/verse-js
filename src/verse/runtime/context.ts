// context.ts
// Execution context threaded through compiled closures. `Ctx` is per
// concurrency strand (it carries the current task and transaction); the
// `SharedCtx` inside it is per run.

import type { NativeRegistry } from '../bindings/registry';
import { Transaction } from './failure';
import { Scheduler, Task } from './scheduler';
import { Value, VFunctionValue } from './values';

export type OutputLevel = 'stdout' | 'error' | 'system';

export interface DebugHooks {
	/** Awaited before each statement in debug builds. `env` is the current
	 * frame (with `names` populated) for variable inspection; `file` is the
	 * workspace file the statement lives in. */
	onStatement(line: number | null, file: string | null, ctx: Ctx, env: unknown): Promise<void> | void;
	/** Called when entering/leaving user functions (call stack display). */
	onEnterFunction(name: string, line: number | null, file: string | null): void;
	onLeaveFunction(): void;
}

/**
 * Synchronous key/value storage for Verse `<persistable>` weak_map data.
 * The runtime loads each persistent map at run start and writes it back at
 * the end of the run. Implementations live in `verse-js/adapters` (memory,
 * localStorage) and `verse-js/adapters/node` (JSON file).
 */
export interface PersistenceAdapter {
	/** Returns the stored JSON for a key, or null when absent. */
	load(key: string): string | null;
	/** Stores JSON under a key (write-through). */
	store(key: string, json: string): void;
	/**
	 * Removes every entry managed by this adapter, resetting all Verse
	 * persistent state it backs. Optional; hosts/UIs offering a "reset
	 * persistent data" action should call this.
	 */
	clear?(): void;
}

export interface SharedCtx {
	scheduler: Scheduler;
	out: (level: OutputLevel, text: string) => void;
	rng: () => number;
	globals: Value[];
	debug: DebugHooks | null;
	persistence: PersistenceAdapter | null;
	persistenceKeys: Map<string, string>;
	/** Bindings the program was compiled against (native method dispatch). */
	natives: NativeRegistry | null;
	extensionMethods: Map<string, VFunctionValue>;
	/** Sync-section iteration guard (backedges before an error is thrown). */
	loopBudget: number;
	profile: (label: string, seconds: number) => void;
}

export class Ctx {
	shared: SharedCtx;
	task: Task;
	txn: Transaction | null;
	/** Active defer list of the innermost defer-carrying block. */
	defers: unknown[] | null = null;
	/** Branch tasks started in the current function invocation; cancelled
	 * when the invocation returns (structured concurrency scoping). */
	branchTasks: Task[] | null = null;
	/** Line of the statement currently executing (error reporting). */
	line: number | null = null;
	/** Workspace file of the statement currently executing. */
	file: string | null = null;

	constructor(shared: SharedCtx, task: Task, txn: Transaction | null = null) {
		this.shared = shared;
		this.task = task;
		this.txn = txn;
	}

	forTask(task: Task): Ctx {
		// New strand: transactions and defers do not cross task boundaries.
		return new Ctx(this.shared, task, null);
	}
}
