// stdlib/index.ts
// The core standard library: every /Verse.org module. Always registered by
// createHost; hosts add extras (e.g. verse-js/extras/uefn) on top.

import { NativeModuleDef } from '../bindings/registry';
import { colorsModule } from './colors';
import { concurrencyModule } from './concurrency';
import { preludeModule } from './prelude';
import { randomModule } from './random';
import { simulationModule } from './simulation';

export { preludeModule } from './prelude';
export {
	simulationModule,
	eventClassInfo,
	taskClassInfo,
	playerClassInfo,
	agentClassInfo,
} from './simulation';
export { concurrencyModule } from './concurrency';
export { randomModule } from './random';
export { colorsModule } from './colors';

/** All /Verse.org core modules, in registration order. */
export const coreModules: NativeModuleDef[] = [
	preludeModule,
	randomModule,
	simulationModule,
	concurrencyModule,
	colorsModule,
];
