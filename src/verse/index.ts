// index.ts
// Public API of the verse-js embeddable runtime.
//
// Quickstart:
//
// ```ts
// import { createHost } from 'verse-js';
// import { uefnModules } from 'verse-js/extras/uefn';
//
// const host = createHost({ modules: uefnModules });
// const { output, errors } = await host.execute('Print("Hello")');
// ```
//
// See ARCHITECTURE.md for the pipeline and extension points.

// --- Host: compile / run / execute / docs / analyze ---
export {
	createHost,
	VerseHost,
	startRun,
	compileProgram,
	tryLex,
	VerseRuntimeError,
	VerseRunCancelled,
	VerseTaskCancelled,
} from './host';
export type {
	HostOptions,
	RunOptions,
	VerseRun,
	ExecuteResult,
	CompileOutcome,
	CompileSuccess,
	CompileFailure,
	IdeDiagnostic,
	CompiledProgram,
	Diagnostic,
} from './host';

// --- Bindings: declare native modules for a host ---
export {
	defineModule,
	declareNativeClass,
	ModuleBuilder,
	NativeRegistry,
	T,
	makeEffects,
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
} from './bindings/index';
export type {
	NativeImpl,
	NativeMethodImpl,
	NativeSignature,
	NativeModuleDef,
	NativeEntry,
	ModuleOptions,
	NativeClassSpec,
	ClassEntryOptions,
	EntryPointSpec,
	Value,
	Failable,
	Ctx,
	VType,
	FuncT,
	ClassInfo,
	EnumInfo,
	EffectSet,
} from './bindings/index';

// --- Standard library modules (registered by default) ---
export { coreModules } from './stdlib/index';

// --- Runtime interfaces embedders may implement ---
export type {
	PersistenceAdapter,
	DebugHooks,
	OutputLevel,
	SharedCtx,
} from './runtime/context';
export { Scheduler, RealClock, VirtualClock, VerseEvent } from './runtime/scheduler';
export type { Clock, Task } from './runtime/scheduler';

// --- Documentation generation ---
export {
	generateDocs,
	buildSymbolIndex,
	getModulePaths,
	symbolDocToMarkdown,
} from './docs';
export type { ModuleDoc, SymbolDoc, IndexedSymbolDoc } from './docs';

// --- IDE language services (see also verse-js/analysis) ---
export { analysisFromOutcome, hoverAt, definitionAt, completionsAt, findNodePath } from './analysis';
export type { SourceAnalysis, HoverInfo, CompletionEntry } from './analysis';
