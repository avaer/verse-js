// adapters/node.ts
// Node-only storage adapter (separate entry point so browser bundles never
// import `fs`): persists all keys as one JSON object file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersistenceAdapter } from '../runtime/context';

/**
 * File-backed storage for Node: all keys live in a single JSON object
 * file. Reads lazily on first access, writes through on every store, and
 * creates the parent directory if needed. A corrupt or missing file starts
 * empty.
 */
export class JsonFileStorageAdapter implements PersistenceAdapter {
	private readonly filePath: string;
	private data: Record<string, string> | null = null;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	private ensureLoaded(): Record<string, string> {
		if (this.data === null) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
				this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? parsed as Record<string, string>
					: {};
			} catch {
				this.data = {};
			}
		}
		return this.data;
	}

	load(key: string): string | null {
		return this.ensureLoaded()[key] ?? null;
	}

	store(key: string, json: string): void {
		const data = this.ensureLoaded();
		data[key] = json;
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, '\t'));
	}
}
