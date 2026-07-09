// failure.ts
// Runtime errors and the transaction journal that implements Verse's
// speculative-execution semantics: failure contexts (and `transacts` bodies)
// journal every mutation so a failure rolls the world back, mirroring
// Epic's VVMFailureContext/FTransaction design.

import { Value, VMap, VObject } from './values';

export class VerseRuntimeError extends Error {
	line: number | null;

	constructor(message: string, line: number | null = null) {
		super(message);
		this.name = 'VerseRuntimeError';
		this.line = line;
	}
}

/** Thrown when the user presses Stop; unwinds the whole run. */
export class VerseRunCancelled extends Error {
	constructor() {
		super('Execution stopped');
		this.name = 'VerseRunCancelled';
	}
}

/** Thrown inside a task when it is cancelled (race loser, .Cancel(), ...). */
export class VerseTaskCancelled extends Error {
	constructor() {
		super('Task cancelled');
		this.name = 'VerseTaskCancelled';
	}
}

/** Internal control-flow signals for break/return. */
export class BreakSignal {
	static readonly instance = new BreakSignal();
}

export class ReturnSignal {
	value: Value;

	constructor(value: Value) {
		this.value = value;
	}
}

type JournalEntry =
	| { kind: 'slot'; env: Value[]; index: number; prev: Value }
	| { kind: 'field'; obj: VObject; name: string; prev: Value }
	| { kind: 'elem'; arr: Value[]; index: number; prev: Value }
	| { kind: 'arrayLen'; arr: Value[]; prevLen: number }
	| { kind: 'mapEntry'; map: VMap; key: Value; had: boolean; prev: [Value, Value] | undefined }
	| { kind: 'custom'; undo: () => void };

export class Transaction {
	/** Allocated lazily on the first journaled write. */
	entries: JournalEntry[] | null = null;
	parent: Transaction | null;

	constructor(parent: Transaction | null = null) {
		this.parent = parent;
	}

	private push(entry: JournalEntry): void {
		(this.entries ??= []).push(entry);
	}

	recordSlot(env: Value[], index: number): void {
		this.push({ kind: 'slot', env, index, prev: env[index] });
	}

	recordField(obj: VObject, name: string): void {
		this.push({ kind: 'field', obj, name, prev: obj.fields.get(name) });
	}

	recordElem(arr: Value[], index: number): void {
		this.push({ kind: 'elem', arr, index, prev: arr[index] });
	}

	recordArrayLength(arr: Value[]): void {
		this.push({ kind: 'arrayLen', arr, prevLen: arr.length });
	}

	recordMapEntry(map: VMap, key: Value): void {
		// The stored pair keeps the original key object, so rollback can
		// re-insert through the map's own two-tier key logic.
		const prev = map.getPair(key);
		this.push({
			kind: 'mapEntry',
			map,
			key,
			had: prev !== undefined,
			prev,
		});
	}

	recordCustom(undo: () => void): void {
		this.push({ kind: 'custom', undo });
	}

	rollback(): void {
		const entries = this.entries;
		if (!entries) {
			return;
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			switch (entry.kind) {
				case 'slot':
					entry.env[entry.index] = entry.prev;
					break;
				case 'field':
					entry.obj.fields.set(entry.name, entry.prev);
					break;
				case 'elem':
					entry.arr[entry.index] = entry.prev;
					break;
				case 'arrayLen':
					entry.arr.length = entry.prevLen;
					break;
				case 'mapEntry':
					if (entry.had && entry.prev) {
						entry.map.set(entry.prev[0], entry.prev[1]);
					} else {
						entry.map.delete(entry.key);
					}
					break;
				case 'custom':
					entry.undo();
					break;
			}
		}
		this.entries = null;
	}

	/** Merge into the parent so an outer failure can still undo our writes. */
	commit(): void {
		const entries = this.entries;
		if (!entries) {
			return;
		}
		if (this.parent) {
			if (this.parent.entries) {
				this.parent.entries.push(...entries);
			} else {
				this.parent.entries = entries;
				this.entries = null;
				return;
			}
		}
		this.entries = null;
	}
}
