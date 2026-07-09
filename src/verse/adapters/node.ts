// adapters/node.ts
// Node-only adapters (separate entry point so browser bundles never import
// `fs`): JSON-file persistence and a directory-backed source filesystem.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PersistenceAdapter } from '../runtime/context';
import type { SourceFileSystem } from '../vfs';

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
		this.flush(data);
	}

	/** Removes every stored entry and writes the emptied file. */
	clear(): void {
		this.data = {};
		this.flush(this.data);
	}

	private flush(data: Record<string, string>): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(data, null, '\t'));
	}
}

/**
 * Directory-backed source filesystem for Node: exposes every `.verse` file
 * directly inside a directory (non-recursive) to workspace compilation,
 * reading lazily from disk. File paths are the bare file names, matching
 * how the IDE names workspace files.
 */
export class NodeSourceFs implements SourceFileSystem {
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	listFiles(): string[] {
		try {
			return readdirSync(this.dir)
				.filter((name) => name.endsWith('.verse'))
				.sort();
		} catch {
			return [];
		}
	}

	readFile(path: string): string | null {
		try {
			return readFileSync(join(this.dir, path), 'utf8');
		} catch {
			return null;
		}
	}
}
