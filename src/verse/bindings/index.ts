// bindings/index.ts
// Public bindings API barrel: everything an embedder needs to declare
// native Verse modules and pass them to a host.

export {
	defineModule,
	declareNativeClass,
	ModuleBuilder,
	NativeRegistry,
	T,
	makeEffects,
} from './registry';

export type {
	NativeImpl,
	NativeMethodImpl,
	NativeSignature,
	NativeEntry,
	NativeFunctionEntry,
	NativeClassEntry,
	NativeValueEntry,
	NativeEnumEntry,
	NativeModuleDef,
	NativeCatalog,
	ModuleOptions,
	NativeClassSpec,
	ClassEntryOptions,
	EntryPointSpec,
	VType,
	FuncT,
	ClassInfo,
	EnumInfo,
	EffectSet,
} from './registry';

// Runtime value helpers embedders need when implementing natives.
export {
	FAIL,
	VMap,
	VObject,
	VOption,
	VRational,
	VTuple,
	VNativeFunction,
	verseToString,
	verseToDiagnostic,
	verseEquals,
} from '../runtime/values';
export type { Value, Failable } from '../runtime/values';
export { VerseRuntimeError } from '../runtime/failure';
export type { Ctx } from '../runtime/context';
