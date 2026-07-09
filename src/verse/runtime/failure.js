// failure.js
// Verse failure semantics. A `VerseFailure` models the failure of a
// `decides`-effect expression: it is caught at the enclosing failure context
// (the condition of an `if`, the left operand of `or`, ...).
//
// Mirroring Epic's VerseVM (VVMFailureContext / FTransaction), each failure
// context opens a transaction that journals variable and array-element
// writes; when the context fails, the journal is rolled back so failed
// speculative execution leaves no observable side effects.

export class VerseFailure extends Error {
	constructor(message) {
		super(message);
		this.name = 'VerseFailure';
	}
}

// Thrown when the user presses Stop; unwinds the whole interpreter run.
export class VerseRunCancelled extends Error {
	constructor() {
		super('Execution stopped');
		this.name = 'VerseRunCancelled';
	}
}

export class Transaction {
	constructor() {
		this.entries = [];
	}

	// Journal a symbol-table slot before it is overwritten.
	recordSymbolWrite(symbolTable, name) {
		this.entries.push({
			kind: 'symbol',
			symbolTable,
			name,
			hadKey: symbolTable.has(name),
			previous: symbolTable.get(name),
		});
	}

	// Journal an array element before it is overwritten.
	recordElementWrite(array, index) {
		this.entries.push({
			kind: 'element',
			array,
			index,
			previous: array[index],
		});
	}

	rollback() {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry.kind === 'symbol') {
				if (entry.hadKey) {
					entry.symbolTable.set(entry.name, entry.previous);
				} else {
					entry.symbolTable.delete(entry.name);
				}
			} else {
				entry.array[entry.index] = entry.previous;
			}
		}
		this.entries.length = 0;
	}

	// Merge this transaction's journal into an enclosing transaction so an
	// outer failure can still roll back writes committed by an inner context.
	commitInto(parent) {
		if (parent) {
			parent.entries.push(...this.entries);
		}
		this.entries.length = 0;
	}
}
