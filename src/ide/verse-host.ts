// verse-host.ts
// The IDE's shared Verse host: core stdlib + UEFN extras. The run
// pipeline, docs panel, and Monaco's static docs index consume this host;
// per-keystroke semantic analysis runs in a worker with its own
// identically-configured host (see analysis-client.ts).

import { createHost } from '@/src/verse';
import { uefnModules } from '@/src/verse/extras/uefn';
import { LocalStorageAdapter } from '@/src/verse/adapters';

export const ideHost = createHost({ modules: uefnModules });

/**
 * The IDE's persistent-data store (Verse `<persistable>` weak_maps). One
 * shared instance so runs and the toolbar's Reset button (which calls
 * `idePersistence.clear()`) operate on the same data.
 */
export const idePersistence = new LocalStorageAdapter();
