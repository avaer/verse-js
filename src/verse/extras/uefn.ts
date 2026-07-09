// uefn.ts
// Optional UEFN/Fortnite extras, in the spirit of three.js "examples/"
// addons: import and pass to createHost to run UEFN-style programs.
// Deliberately built only through the public bindings API (defineModule,
// declareNativeClass) — the same surface any embedder uses.

import {
	declareNativeClass, defineModule, NativeModuleDef, T,
} from '../bindings/index';
import { verseToString, VObject } from '../bindings/index';

export const creativeDeviceClassInfo = declareNativeClass({
	name: 'creative_device',
	methods: [
		{ name: 'OnBegin', signature: { params: [], ret: T.void, effects: { suspends: true } } },
		{ name: 'OnEnd', signature: { params: [], ret: T.void } },
	],
});

/**
 * `/Fortnite.com/Devices`: a minimal `creative_device` shim. Classes
 * extending it become program entry points — the runtime instantiates each
 * and invokes `OnBegin` after top-level statements, matching UEFN.
 */
export const devicesModule = defineModule(
	'/Fortnite.com/Devices',
	'Minimal creative_device shim: subclass it and override OnBegin as your program entry point. Full Fortnite device APIs are out of scope for this environment.',
	(m) => {
		m.cls('creative_device', creativeDeviceClassInfo, {
			construct: () => new VObject(
				{ name: 'creative_device', isStruct: false, conforms: (n) => n === 'creative_device' },
				new Map(),
			),
			doc: 'Base class for device scripts. Override OnBegin<override>()<suspends> to run code.',
			example: 'my_device := class(creative_device):\n    OnBegin<override>()<suspends> : void =\n        Print("Hello!")',
		});
	},
	{
		entryPoint: { className: 'creative_device', method: 'OnBegin' },
		// Unmodeled UEFN modules degrade to warnings so real UEFN sources run.
		toleratedRoots: ['/Fortnite.com', '/UnrealEngine.com'],
	},
);

/** `/UnrealEngine.com/Temporary/Diagnostics`: Print, as in UEFN. */
export const diagnosticsModule = defineModule(
	'/UnrealEngine.com/Temporary/Diagnostics',
	'Debug output. In UEFN this module provides Print; here Print is also available without any import.',
	(m) => {
		m.fn('Print', { params: [['Message', T.string]], ret: T.void },
			(args, ctx) => {
				ctx.shared.out('stdout', verseToString(args[0]));
				return undefined;
			},
			'Writes a message to the log/console.',
			'Print("Hello, world!")');
	},
);

/** All UEFN extras, ready for `createHost({ modules: uefnModules })`. */
export const uefnModules: NativeModuleDef[] = [devicesModule, diagnosticsModule];
