// scheduler.ts
// Structured concurrency runtime: tasks, events, and the simulation clock.
//
// Verse semantics implemented here:
//   spawn  - unstructured: task attaches to the run root, returns task value
//   race   - first clause to complete wins; losers are cancelled
//   sync   - waits for all clauses; returns a tuple of results
//   rush   - first result returns; the rest keep running in the enclosing scope
//   branch - starts work that is cancelled when the enclosing scope exits
//
// Cancellation is cooperative: tasks unwind (VerseTaskCancelled) at their
// next suspension point. The clock is pluggable so tests fast-forward Sleep.

import { VerseRunCancelled, VerseTaskCancelled } from './failure';
import { Value, VEventValue, VTask } from './values';

export interface Clock {
	/** Seconds since run start. */
	now(): number;
	/** Resolves after `seconds`; rejects on cancel. */
	wait(seconds: number, task: Task): Promise<void>;
}

export class RealClock implements Clock {
	private start = Date.now();

	now(): number {
		return (Date.now() - this.start) / 1000;
	}

	wait(seconds: number, task: Task): Promise<void> {
		return new Promise((resolve, reject) => {
			const ms = Math.max(0, seconds * 1000);
			const timer = setTimeout(() => {
				task.removeCancelHook(onCancel);
				resolve();
			}, ms);
			const onCancel = (reason: Error) => {
				clearTimeout(timer);
				reject(reason);
			};
			task.addCancelHook(onCancel);
		});
	}
}

// setTimeout(0) is clamped to >=1ms; setImmediate (Node) is far faster for
// the drain loop the virtual clock runs thousands of times.
const nextMacrotask: () => Promise<void> =
	typeof setImmediate === 'function'
		? () => new Promise((resolve) => setImmediate(resolve))
		: () => new Promise((resolve) => setTimeout(resolve, 0));

interface VirtualTimer {
	at: number;
	resolve: () => void;
	reject: (e: Error) => void;
	task: Task;
}

export class VirtualClock implements Clock {
	private current = 0;
	private timers: VirtualTimer[] = [];

	now(): number {
		return this.current;
	}

	wait(seconds: number, task: Task): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer: VirtualTimer = {
				at: this.current + Math.max(0, seconds),
				resolve,
				reject,
				task,
			};
			const onCancel = (reason: Error) => {
				this.timers = this.timers.filter((t) => t !== timer);
				reject(reason);
			};
			task.addCancelHook(onCancel);
			const originalResolve = timer.resolve;
			timer.resolve = () => {
				task.removeCancelHook(onCancel);
				originalResolve();
			};
			this.timers.push(timer);
		});
	}

	get hasTimers(): boolean {
		return this.timers.length > 0;
	}

	/** Advances to the earliest pending timer and fires everything due. */
	advance(): boolean {
		if (this.timers.length === 0) {
			return false;
		}
		const next = Math.min(...this.timers.map((t) => t.at));
		this.current = next;
		const due = this.timers.filter((t) => t.at <= next);
		this.timers = this.timers.filter((t) => t.at > next);
		for (const timer of due) {
			timer.resolve();
		}
		return true;
	}

	/**
	 * Drives `root` to completion, draining the microtask queue between
	 * virtual-time steps. Deterministic Sleep for tests and benchmarks.
	 */
	async run<TResult>(root: Promise<TResult>): Promise<TResult> {
		let settled = false;
		let result: { ok: true; value: TResult } | { ok: false; error: unknown } | null = null;
		root.then(
			(value) => { settled = true; result = { ok: true, value }; },
			(error) => { settled = true; result = { ok: false, error }; },
		);
		for (let guard = 0; guard < 1_000_000; guard++) {
			// Drain pending continuations (macrotask lets promise chains run).
			await nextMacrotask();
			if (settled) {
				break;
			}
			if (!this.advance()) {
				// No timers and not settled: wait one more tick for real async
				// (shouldn't happen under the virtual clock), then bail.
				await nextMacrotask();
				if (settled || !this.advance()) {
					break;
				}
			}
		}
		if (!settled || result === null) {
			throw new Error('Virtual clock: run did not settle (deadlock or missing timer)');
		}
		const r = result as { ok: true; value: TResult } | { ok: false; error: unknown };
		if (r.ok) {
			return r.value;
		}
		throw r.error;
	}
}

export type TaskState = 'running' | 'completed' | 'failed' | 'cancelled';

export class Task implements VTask {
	readonly isVerseTask = true as const;
	readonly id: number;
	name: string;
	state: TaskState = 'running';
	result: Value = undefined;
	error: unknown = null;
	parent: Task | null;
	children: Set<Task> = new Set();
	/** Children created by `branch`; cancelled when this task's body exits. */
	branchChildren: Set<Task> = new Set();
	private cancelHooks: ((reason: Error) => void)[] = [];
	private waiters: { resolve: (v: Value) => void; reject: (e: unknown) => void }[] = [];
	scheduler: Scheduler;

	constructor(scheduler: Scheduler, parent: Task | null, name: string) {
		this.scheduler = scheduler;
		this.parent = parent;
		this.name = name;
		this.id = scheduler.nextTaskId++;
		if (parent) {
			parent.children.add(this);
		}
		scheduler.liveTasks.add(this);
	}

	get cancelled(): boolean {
		return this.state === 'cancelled';
	}

	throwIfCancelled(): void {
		if (this.scheduler.runCancelled) {
			throw new VerseRunCancelled();
		}
		if (this.state === 'cancelled') {
			throw new VerseTaskCancelled();
		}
	}

	addCancelHook(hook: (reason: Error) => void): void {
		if (this.state === 'cancelled') {
			hook(new VerseTaskCancelled());
			return;
		}
		if (this.scheduler.runCancelled) {
			hook(new VerseRunCancelled());
			return;
		}
		this.cancelHooks.push(hook);
	}

	removeCancelHook(hook: (reason: Error) => void): void {
		const index = this.cancelHooks.indexOf(hook);
		if (index >= 0) {
			this.cancelHooks.splice(index, 1);
		}
	}

	/** Wraps a promise so cancellation interrupts the wait. */
	suspendable<TValue>(promise: Promise<TValue>): Promise<TValue> {
		return new Promise<TValue>((resolve, reject) => {
			let done = false;
			const onCancel = (reason: Error) => {
				if (!done) {
					done = true;
					reject(reason);
				}
			};
			this.addCancelHook(onCancel);
			promise.then(
				(value) => {
					if (!done) {
						done = true;
						this.removeCancelHook(onCancel);
						resolve(value);
					}
				},
				(error) => {
					if (!done) {
						done = true;
						this.removeCancelHook(onCancel);
						reject(error);
					}
				},
			);
		});
	}

	complete(result: Value): void {
		if (this.state !== 'running') {
			return;
		}
		this.state = 'completed';
		this.result = result;
		this.finish();
		for (const waiter of this.waiters) {
			waiter.resolve(result);
		}
		this.waiters.length = 0;
	}

	fail(error: unknown): void {
		if (this.state !== 'running') {
			return;
		}
		this.state = error instanceof VerseTaskCancelled ? 'cancelled' : 'failed';
		this.error = error;
		this.finish();
		for (const waiter of this.waiters) {
			waiter.reject(error);
		}
		this.waiters.length = 0;
	}

	cancel(): void {
		if (this.state !== 'running') {
			return;
		}
		this.state = 'cancelled';
		const reason = new VerseTaskCancelled();
		for (const hook of this.cancelHooks.splice(0)) {
			hook(reason);
		}
		for (const child of [...this.children]) {
			child.cancel();
		}
		this.finish();
		for (const waiter of this.waiters) {
			waiter.reject(reason);
		}
		this.waiters.length = 0;
	}

	private finish(): void {
		this.scheduler.liveTasks.delete(this);
		this.parent?.children.delete(this);
		// Structured cleanup: branch children die with their scope.
		for (const child of [...this.branchChildren]) {
			child.cancel();
		}
		this.branchChildren.clear();
	}

	isComplete(): boolean {
		return this.state !== 'running';
	}

	awaitResult(): Promise<Value> {
		if (this.state === 'completed') {
			return Promise.resolve(this.result);
		}
		if (this.state === 'failed') {
			return Promise.reject(this.error);
		}
		if (this.state === 'cancelled') {
			return Promise.reject(new VerseTaskCancelled());
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}
}

export class VerseEvent implements VEventValue {
	readonly isVerseEvent = true as const;
	private waiters: ((payload: Value) => void)[] = [];

	signal(payload: Value): void {
		const current = this.waiters.splice(0);
		for (const waiter of current) {
			waiter(payload);
		}
	}

	awaitSignal(): Promise<Value> {
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

export class Scheduler {
	clock: Clock;
	nextTaskId = 1;
	liveTasks: Set<Task> = new Set();
	rootTask: Task;
	runCancelled = false;

	constructor(clock?: Clock) {
		this.clock = clock ?? new RealClock();
		this.rootTask = new Task(this, null, '(program)');
	}

	cancelRun(): void {
		this.runCancelled = true;
		for (const task of [...this.liveTasks]) {
			task.cancel();
		}
	}

	spawnTask(parent: Task, name: string, body: (task: Task) => Promise<Value>): Task {
		const task = new Task(this, parent, name);
		body(task).then(
			(value) => task.complete(value),
			(error) => task.fail(error),
		);
		return task;
	}

	sleep(task: Task, seconds: number): Promise<void> {
		task.throwIfCancelled();
		return this.clock.wait(seconds, task);
	}

	/** Snapshot for the debugger UI. */
	taskList(): { id: number; name: string; state: TaskState }[] {
		return [...this.liveTasks].map((t) => ({ id: t.id, name: t.name, state: t.state }));
	}
}
