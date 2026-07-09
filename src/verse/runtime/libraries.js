// libraries.js
// Native module registry for the Verse subset: the JS-side implementation of
// the built-in Verse API surface (what UEFN ships as digests + native thunks).
// Vendorized from johanfortus/Verse-Online-Editor (MIT) and extended with
// /Verse.org/Simulation's Sleep (a `suspends` native mapped onto an awaited
// timeout) and explicit "not implemented" stubs for UEFN-only APIs.
//
// Symbols carry documentation metadata (doc, paramNames, module description).
// The IDE's Docs panel, editor hovers, and completions are all generated from
// this registry - see ./docs.js.

import { VerseFailure } from './failure.js';

class VerseNotImplementedError extends Error {
	constructor(symbolName) {
		super(`'${symbolName}' is not implemented in verse-js. Only pure language features and a small native registry are supported outside UEFN.`);
		this.name = 'VerseNotImplementedError';
	}
}

function createNativeFunction(name, parameters, returnType, invoke, options = {}) {
	const { effects = [], overloads = null, doc = '', paramNames = null, example = '' } = options;
	return {
		metadata: {
			type: 'NativeFunction',
			name,
			parameters,
			returnType,
			effects,
			overloads,
			doc,
			paramNames,
			example,
		},
		runtime: {
			invoke,
		},
	};
}

function createNotImplementedFunction(name, parameters, returnType, options = {}) {
	return createNativeFunction(name, parameters, returnType, () => {
		throw new VerseNotImplementedError(name);
	}, options);
}

function convertFailableFloatToInt(name, value, convert) {
	if (!Number.isFinite(value)) {
		throw new VerseFailure(`${name}[${value}] failed: value is not finite`);
	}

	return convert(value);
}

function shuffleArray(values) {
	const shuffled = [...values];

	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const randomIndex = Math.floor(Math.random() * (index + 1));
		[shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
	}

	return shuffled;
}

const VERSE_LIBRARY_REGISTRY = {
	'/Fortnite.com/Devices': {
		description: 'Creative device classes. In UEFN this module exposes the full device API; here it provides the creative_device base class that serves as the program entry point.',
		exports: {
			creative_device: {
				type: 'NativeClass',
				name: 'creative_device',
				doc: 'Base class for creative devices. Every class extending creative_device is instantiated when the program runs, and its OnBegin<override>()<suspends> method is invoked as the entry point.',
				example: 'my_device := class(creative_device):\n    OnBegin<override>()<suspends> : void =\n        Print("Hello!")',
			},
		},
	},
	'/Verse.org/Simulation': {
		description: 'Simulation and time control. Sleep is fully supported; playspace APIs are UEFN-only stubs.',
		exports: {
			// Sleep is a `suspends` native. The async interpreter awaits its
			// promise, so Verse coroutine code maps directly onto JS async.
			Sleep: createNativeFunction(
				'Sleep',
				['float'],
				'void',
				seconds => new Promise(resolve => {
					const clampedMs = Math.max(0, Number(seconds) * 1000);
					setTimeout(resolve, clampedMs);
				}),
				{
					effects: ['suspends'],
					paramNames: ['Seconds'],
					doc: 'Suspends the current invocation for Seconds seconds. Output printed before a Sleep appears immediately; execution resumes after the delay. Pressing Stop interrupts an in-progress Sleep.',
					example: 'Print("3...")\nSleep(1.0)\nPrint("2...")',
				},
			),
			GetPlayspace: createNotImplementedFunction('GetPlayspace', [], 'void', {
				doc: 'Returns the playspace the device belongs to. Not implemented in verse-js (UEFN-only); calling it raises a runtime error.',
			}),
		},
	},
	'/Verse.org/Random': {
		description: 'Pseudo-random number utilities.',
		exports: {
			GetRandomFloat: createNativeFunction(
				'GetRandomFloat',
				['float', 'float'],
				'float',
				(min, max) => Math.random() * (max - min) + min,
				{
					paramNames: ['Min', 'Max'],
					doc: 'Returns a uniformly distributed random float in the range [Min, Max).',
					example: 'Chance := GetRandomFloat(0.0, 1.0)',
				},
			),
			GetRandomInt: createNativeFunction(
				'GetRandomInt',
				['int', 'int'],
				'int',
				(min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
				{
					paramNames: ['Min', 'Max'],
					doc: 'Returns a uniformly distributed random int in the inclusive range [Min, Max].',
					example: 'Roll := GetRandomInt(1, 6)',
				},
			),
			Shuffle: createNativeFunction(
				'Shuffle',
				['array'],
				'array',
				values => {
					if (!Array.isArray(values)) {
						throw new Error('Shuffle expects an array');
					}

					return shuffleArray(values);
				},
				{
					paramNames: ['Values'],
					doc: 'Returns a new array containing the elements of Values in a random order. The input array is not modified.',
					example: 'Deck := Shuffle(Cards)',
				},
			),
		},
	},
	'/UnrealEngine.com/Temporary/Diagnostics': {
		description: 'Diagnostic output. Print is implemented as a built-in statement in this interpreter, so importing this module is accepted for compatibility but adds no symbols.',
		// Print is a grammar-level statement in this implementation; it routes
		// through the interpreter's output sink (the IDE console). A synthetic
		// docs entry for it is added in docs.js.
		exports: {},
	},
	'/UnrealEngine.com/Temporary/SpatialMath': {
		description: 'Vectors, rotations, and transforms. UEFN-only; accepted for compatibility but no symbols are available in verse-js.',
		exports: {},
	},
	'/Verse.org/Verse': {
		description: 'The language prelude: core math and conversion functions. Implicitly imported into every file - no using declaration needed.',
		exports: {
			Floor: createNativeFunction(
				'Floor',
				['float'],
				'int',
				value => convertFailableFloatToInt('Floor', value, Math.floor),
				{
					effects: ['decides'],
					paramNames: ['Value'],
					doc: 'Rounds Value down to the nearest int. The float overload has the decides effect (it fails on non-finite values), so call it as Floor[X] inside a failure context. The int and rational overloads never fail.',
					example: 'if (Whole := Floor[3.7]):\n    Print("{Whole}")  # 3',
					overloads: [
						{ parameterTypes: ['int'], returnType: 'int', effects: [] },
						{ parameterTypes: ['rational'], returnType: 'int', effects: [] },
						{ parameterTypes: ['float'], returnType: 'int', effects: ['decides'] },
					],
				},
			),
			Ceil: createNativeFunction(
				'Ceil',
				['float'],
				'int',
				value => convertFailableFloatToInt('Ceil', value, Math.ceil),
				{
					effects: ['decides'],
					paramNames: ['Value'],
					doc: 'Rounds Value up to the nearest int. Has the decides effect (fails on non-finite values); call as Ceil[X] inside a failure context.',
					example: 'if (Whole := Ceil[3.2]):\n    Print("{Whole}")  # 4',
				},
			),
			Round: createNativeFunction(
				'Round',
				['float'],
				'int',
				value => convertFailableFloatToInt('Round', value, Math.round),
				{
					effects: ['decides'],
					paramNames: ['Value'],
					doc: 'Rounds Value to the nearest int. Has the decides effect (fails on non-finite values); call as Round[X] inside a failure context.',
					example: 'if (Whole := Round[3.5]):\n    Print("{Whole}")  # 4',
				},
			),
			Int: createNativeFunction(
				'Int',
				['float'],
				'int',
				value => convertFailableFloatToInt('Int', value, Math.trunc),
				{
					effects: ['decides'],
					paramNames: ['Value'],
					doc: 'Truncates Value toward zero, producing an int. Has the decides effect (fails on non-finite values); call as Int[X] inside a failure context.',
					example: 'if (Whole := Int[-3.7]):\n    Print("{Whole}")  # -3',
				},
			),
			Mod: createNativeFunction(
				'Mod',
				['int', 'int'],
				'int',
				(dividend, divisor) => {
					if (divisor === 0) {
						throw new VerseFailure(`Mod[${dividend}, ${divisor}] failed: division by zero`);
					}

					return ((dividend % divisor) + divisor) % divisor;
				},
				{
					effects: ['decides'],
					paramNames: ['Dividend', 'Divisor'],
					doc: 'Returns Dividend modulo Divisor (always non-negative). Has the decides effect: fails when Divisor is 0, so call as Mod[A, B] inside a failure context.',
					example: 'if (Remainder := Mod[7, 3]):\n    Print("{Remainder}")  # 1',
				},
			),
			Quotient: createNativeFunction(
				'Quotient',
				['int', 'int'],
				'int',
				(dividend, divisor) => {
					if (divisor === 0) {
						throw new VerseFailure(`Quotient[${dividend}, ${divisor}] failed: division by zero`);
					}

					return Math.trunc(dividend / divisor);
				},
				{
					effects: ['decides'],
					paramNames: ['Dividend', 'Divisor'],
					doc: 'Integer division truncated toward zero. Has the decides effect: fails when Divisor is 0, so call as Quotient[A, B] inside a failure context.',
					example: 'if (Half := Quotient[7, 2]):\n    Print("{Half}")  # 3',
				},
			),
		},
	},
};

const SYMBOL_IMPORT_SUGGESTIONS = new Map();

for (const [libraryPath, library] of Object.entries(VERSE_LIBRARY_REGISTRY)) {
	for (const symbolName of Object.keys(library.exports)) {
		SYMBOL_IMPORT_SUGGESTIONS.set(symbolName, libraryPath);
	}
}

// /Verse.org/Verse is the language prelude - real Verse makes it available
// in every file without an explicit `using`, so it's always in scope here too.
const IMPLICITLY_IMPORTED_PATHS = ['/Verse.org/Verse'];

export function resolveImportPaths(explicitImportPaths) {
	return [...new Set([...IMPLICITLY_IMPORTED_PATHS, ...explicitImportPaths])];
}

export function getLibrary(path) {
	return VERSE_LIBRARY_REGISTRY[path] || null;
}

export function getSuggestedUsingForSymbol(symbolName) {
	return SYMBOL_IMPORT_SUGGESTIONS.get(symbolName) || null;
}

export function getImportedSymbols(importPaths) {
	const symbols = new Map();

	for (const importPath of importPaths) {
		const library = getLibrary(importPath);
		if (!library) {
			continue;
		}

		for (const [symbolName, exportedSymbol] of Object.entries(library.exports)) {
			const symbol = exportedSymbol.metadata || exportedSymbol;
			if (!symbol) {
				continue;
			}

			symbols.set(symbolName, { ...symbol, importedFrom: importPath });
		}
	}

	return symbols;
}

export function getImportedRuntimeBindings(importPaths) {
	const nativeFunctions = new Map();

	for (const importPath of importPaths) {
		const library = getLibrary(importPath);
		if (!library) {
			continue;
		}

		for (const [symbolName, exportedSymbol] of Object.entries(library.exports)) {
			if (exportedSymbol.metadata?.type === 'NativeFunction') {
				nativeFunctions.set(symbolName, {
					...exportedSymbol.metadata,
					...exportedSymbol.runtime,
					importedFrom: importPath,
				});
				continue;
			}
		}
	}

	return {
		nativeFunctions,
	};
}

export { VERSE_LIBRARY_REGISTRY, IMPLICITLY_IMPORTED_PATHS, VerseNotImplementedError };
