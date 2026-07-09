// verse-host.ts
// The IDE's shared Verse host: core stdlib + UEFN extras. Every IDE
// surface (run pipeline, docs panel, Monaco intellisense) consumes this
// one host so they all see the same modules.

import { createHost, MemorySourceFs } from '@/src/verse';
import { uefnModules } from '@/src/verse/extras/uefn';
import { LocalStorageAdapter } from '@/src/verse/adapters';

export const ideHost = createHost({ modules: uefnModules });

/**
 * The IDE's workspace snapshot: every editor file, mirrored by Ide.jsx on
 * each change. The Monaco intellisense layer reads it to analyze the whole
 * workspace (cross-file hover/definition/completions); `version` bumps on
 * every change so analyses can be cached.
 */
export const ideWorkspace = {
	fs: new MemorySourceFs(),
	version: 0,
	setFiles(files: Record<string, string>): void {
		for (const file of this.fs.listFiles()) {
			if (!(file in files)) {
				this.fs.deleteFile(file);
			}
		}
		for (const [file, source] of Object.entries(files)) {
			if (this.fs.readFile(file) !== source) {
				this.fs.writeFile(file, source);
			}
		}
		this.version += 1;
	},
};

/**
 * The IDE's persistent-data store (Verse `<persistable>` weak_maps). One
 * shared instance so runs and the toolbar's Reset button (which calls
 * `idePersistence.clear()`) operate on the same data.
 */
export const idePersistence = new LocalStorageAdapter();
