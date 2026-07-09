// vfs.ts
// Virtual source filesystem: the compiler's view of a multi-file Verse
// workspace. Deliberately minimal and synchronous — compilation is sync, so
// hosts with async storage (IndexedDB, network, ...) load a snapshot into a
// MemorySourceFs first.

/**
 * A snapshot view of Verse sources for workspace compilation.
 *
 * Implementations only need these two methods; `MemorySourceFs` (browser /
 * anywhere) and `NodeSourceFs` (`verse-js/adapters/node`, reads a directory)
 * are provided. Plain `Record<string, string>` objects are accepted anywhere
 * a `SourceFileSystem` is expected (see {@link toSourceFs}).
 */
export interface SourceFileSystem {
	/** All Verse file paths in the workspace, in a stable order. */
	listFiles(): string[];
	/** Source text for a path, or null when the file doesn't exist. */
	readFile(path: string): string | null;
}

/** Anything `compileWorkspace`/`analyzeWorkspace` accept as a workspace. */
export type SourceFsLike = SourceFileSystem | Record<string, string>;

/** Normalizes a plain path->source object into a SourceFileSystem. */
export function toSourceFs(fs: SourceFsLike): SourceFileSystem {
	if (typeof (fs as SourceFileSystem).listFiles === 'function' &&
		typeof (fs as SourceFileSystem).readFile === 'function') {
		return fs as SourceFileSystem;
	}
	return new MemorySourceFs(fs as Record<string, string>);
}

/**
 * Map-backed source filesystem. The default workspace container: seed it
 * from any storage, mutate with `writeFile`/`deleteFile`, and compile.
 */
export class MemorySourceFs implements SourceFileSystem {
	private readonly files = new Map<string, string>();

	constructor(initial: Record<string, string> = {}) {
		for (const [path, source] of Object.entries(initial)) {
			this.files.set(path, source);
		}
	}

	listFiles(): string[] {
		return [...this.files.keys()];
	}

	readFile(path: string): string | null {
		return this.files.get(path) ?? null;
	}

	writeFile(path: string, source: string): void {
		this.files.set(path, source);
	}

	deleteFile(path: string): void {
		this.files.delete(path);
	}
}
