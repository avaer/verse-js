// test-host.ts
// Shared host for tests: core stdlib + the UEFN extras, matching what the
// IDE ships. Suites that need isolation or different modules create their
// own hosts with createHost directly.

import { createHost, VerseHost } from '../../src/verse';
import { uefnModules } from '../../src/verse/extras/uefn';

export function createTestHost(): VerseHost {
	return createHost({ modules: uefnModules });
}

/** Shared instance for suites that only read (compile/run/docs). */
export const testHost = createTestHost();
