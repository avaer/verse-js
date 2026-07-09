// adapters/index.ts
// Storage adapters for Verse `<persistable>` weak_map persistence. The
// runtime talks to a synchronous PersistenceAdapter; pick (or write) an
// implementation and pass it to `createHost({ persistence })` or per run.
// Node's file-backed adapter lives in `verse-js/adapters/node` so browser
// bundles never see `fs`.

import type { PersistenceAdapter } from '../runtime/context';

export type { PersistenceAdapter };

/**
 * In-memory storage: data lives for the lifetime of the adapter instance.
 * The default choice for tests and ephemeral runs; share one instance
 * across runs to persist between them.
 */
export class MemoryStorageAdapter implements PersistenceAdapter {
	private readonly data = new Map<string, string>();

	load(key: string): string | null {
		return this.data.get(key) ?? null;
	}

	store(key: string, json: string): void {
		this.data.set(key, json);
	}

	/** Removes all stored entries. */
	clear(): void {
		this.data.clear();
	}

	/** Snapshot of all stored entries (for inspection/tests). */
	entries(): [string, string][] {
		return [...this.data.entries()];
	}
}

/**
 * Browser localStorage-backed storage. Keys are namespaced with a prefix
 * (default `'verse:'`) so `clear()` can safely remove only the entries
 * this adapter manages, and so multiple embeddings on one origin don't
 * collide — pass a distinct prefix per embedding if you run several.
 */
export class LocalStorageAdapter implements PersistenceAdapter {
	private readonly prefix: string;
	private readonly explicitStorage: Storage | null;

	constructor(options: { prefix?: string; storage?: Storage } = {}) {
		this.prefix = options.prefix ?? 'verse:';
		this.explicitStorage = options.storage ?? null;
	}

	// Resolved lazily so the adapter can be constructed during SSR/module
	// evaluation where `window` doesn't exist yet.
	private get storage(): Storage {
		return this.explicitStorage ?? window.localStorage;
	}

	load(key: string): string | null {
		return this.storage.getItem(this.prefix + key);
	}

	store(key: string, json: string): void {
		this.storage.setItem(this.prefix + key, json);
	}

	/** Removes every key under this adapter's prefix; other data on the
	 * origin (including other prefixes) is untouched. */
	clear(): void {
		const doomed: string[] = [];
		for (let i = 0; i < this.storage.length; i++) {
			const key = this.storage.key(i);
			if (key !== null && key.startsWith(this.prefix)) {
				doomed.push(key);
			}
		}
		for (const key of doomed) {
			this.storage.removeItem(key);
		}
	}
}
