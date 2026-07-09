# verse-js architecture

This document describes how the embeddable Verse runtime is put together:
the compilation pipeline, the value and transaction model, concurrency,
the bindings (native module) system, persistence, and the extension points
an embedder can use. The public API surface is exported from
`src/verse/index.ts`; everything else is internal.

```
        source text
            │
            ▼
   ┌─────────────────┐   frontend/lexer.ts — indentation-aware tokens
   │      lex        │
   └─────────────────┘
            │
            ▼
   ┌─────────────────┐   frontend/parser.ts — recursive descent,
   │     parse       │   per-statement error recovery (parseVerseTolerant)
   └─────────────────┘
            │  AST (frontend/ast.ts)
            ▼
   ┌─────────────────┐   sema/checker.ts — types, effects, scopes/slots;
   │     check       │   consumes the host's NativeCatalog
   └─────────────────┘
            │  AST + SemaData (types, slots, bindings, scopes)
            ▼
   ┌─────────────────┐   runtime/compile-closures.ts — AST -> JS closure
   │ closure-compile │   tree; optional per-statement debug hooks
   └─────────────────┘
            │  CompiledProgram
            ▼
   ┌─────────────────┐   runtime/scheduler.ts — cooperative tasks over a
   │      run        │   pluggable clock; host.run / startRun
   └─────────────────┘
```

## The host

`createHost(options)` (in `host.ts`) is the embedding entry point. A
`VerseHost` owns:

- a **`NativeRegistry`** — the set of native modules visible to programs
  compiled by this host (core stdlib + whatever `options.modules` adds);
- a default **persistence adapter** (overridable per run);
- caches for the checker-facing catalog and generated docs.

Hosts are isolated by construction: two hosts never share bindings, and no
module-level singletons exist in the pipeline. The host exposes five
operations:

| Method | Purpose |
| --- | --- |
| `host.compile(source, { strict? })` | lex + parse + check one buffer; returns `CompileOutcome` with editor-shaped diagnostics |
| `host.compileWorkspace(fs, { strict? })` | same over a multi-file workspace (a `SourceFileSystem` or plain path→source object) |
| `host.prepare(outcome, { debug? })` | closure-compile a checked program (compile once, run many) |
| `host.run(outcomeOrCompiled, options)` | start execution on a fresh scheduler; returns a `VerseRun` handle |
| `host.execute(source, options)` | strict compile + run to completion; collects output/errors |
| `host.executeWorkspace(fs, { entry, ... })` | strict workspace compile + run one entry file to completion |
| `host.docs()` / `host.analyze(source)` / `host.analyzeWorkspace(fs)` | documentation and IDE language services generated from this host's registry |

Compilation is *tolerant* by default: type/effect errors are reported as
diagnostics but don't flip `ok` to false (an IDE wants live diagnostics
while typing). `strict: true` (used by `execute`) refuses to run programs
with errors.

### Workspaces (multi-file compilation)

A workspace is any `SourceFileSystem` (`vfs.ts`) — a synchronous snapshot
view with `listFiles()` and `readFile(path)`. `MemorySourceFs` (core) is
the Map-backed default; `NodeSourceFs` (`verse-js/adapters/node`) reads a
directory of `.verse` files; a plain `Record<string, string>` is accepted
anywhere a filesystem is. Hosts with async storage load a snapshot into a
`MemorySourceFs` first, because compilation is synchronous.

`compileWorkspace` parses each file separately (tolerant, diagnostics
tagged with their `file`), then `checkWorkspace` hoists **all top-level
definitions from all files into one shared module scope** before checking
any bodies — so files can reference each other in any order, with no
import statement needed for same-workspace definitions. Duplicate
top-level names across files are errors that name both files. `using`
imports currently land in the shared scope too (a documented deviation
from per-file scoping). Bindings, class members, and entry classes record
their `declFile` for cross-file go-to-definition.

**Entry semantics** (`run(outcome, { entry })`): classes, functions, and
global initializers from *every* file are set up in file order, then only
the entry file's top-level statements and entry-point classes execute —
other files act as libraries. Omitting `entry` runs every file in order
(the single-file behavior). Compiled statements carry `{file, line}`, the
running `Ctx` exposes both, and `DebugSession` takes per-file breakpoints
(`Record<file, lines[]>`) with `PausedInfo`/call-stack frames reporting
the file they're in.

## Frontend

- **Lexer** (`frontend/lexer.ts`): hand-written; produces INDENT/DEDENT
  tokens from significant whitespace, handles braced blocks, `;`
  separators, string interpolation, and the full reserved-symbol table
  from Epic's `ReservedSymbols.inl`.
- **Parser** (`frontend/parser.ts`): recursive descent over the token
  stream. `parseVerseTolerant` recovers per top-level statement so a typo
  mid-file doesn't blank out diagnostics for the rest of the buffer.
- **AST** (`frontend/ast.ts`): plain discriminated unions. Every node has
  a `span` and a `sema` bag (`SemaData`) that the checker fills in — the
  compiler and IDE services read from there rather than re-deriving facts.

## Semantic analysis

`sema/checker.ts` performs one pass over the program:

- **Types** (`sema/types.ts`): a structural lattice (`VType`) with
  subtyping, parametric types (`where t : type`), unions, options, tuples,
  maps, function types with effects.
- **Effects** (`sema/effects.ts`): the 8 fundamental Verse effects
  (mirroring Epic's `Effects.h`), inferred bottom-up and enforced at call
  sites (e.g. no `<suspends>` call inside a failure context).
- **Scopes and slots** (`sema/scopes.ts`): lexical scopes resolve names to
  `Binding`s carrying slot/frame coordinates, so the compiled code does
  array indexing instead of map lookups. Declaration spans ride on
  bindings for go-to-definition.
- **Natives**: the checker never sees implementations — it consumes a
  `NativeCatalog` (`registry.toCatalog()`): module paths, export
  signatures, docs, plus three pieces of registry-driven metadata:
  - `implicitPaths` — modules imported into every program (the prelude);
  - `entryPoints` — entry-point protocols (see below);
  - `toleratedRoots` — namespace roots where an unknown `using` path
    degrades to a warning instead of an error.

`CheckResult.entryClasses` lists user classes that matched a registered
entry-point protocol; the compiler instantiates each and invokes the
protocol method after top-level statements run.

## The runtime

### Closure compilation

`runtime/compile-closures.ts` turns the checked AST into a tree of JS
closures (`(env, ctx) => value`). The key design point is the
**maybe-promise pattern**: closures return plain values on the synchronous
fast path and only produce Promises at genuine suspension points (`Sleep`,
`Await`, concurrency blocks, debug pauses). Straight-line Verse code
therefore runs without any per-statement async overhead.

Debug builds (`{ debug: true }`) additionally weave a per-statement hook
that awaits `DebugHooks.onStatement` — that's the entire debugger
integration point; run mode pays nothing for it.

### Values

`runtime/values.ts` defines the value model: JS numbers/strings/booleans
for scalars, `VRational`, `VOption`, `VTuple`, `VMap` (insertion-ordered,
structural keys via `canonicalKey`), `VObject`/`VStruct` (structs get
value semantics — copied on assignment), `VFunctionValue` (bound methods),
and first-class type values (`VTypeValue`, `RuntimeClass`,
`NativeClassValue`) that serve as cast targets (`shape[X]`) and archetype
constructors (`shape{...}`).

### Failure semantics and transactions

Failable expressions return the `FAIL` sentinel instead of throwing.
Failure contexts (`if` conditions, `or` left sides, `not`, `<decides>`
bodies, loop filters) open a `Transaction` (`runtime/failure.ts`): every
mutation inside is journaled, and on failure the journal rolls back —
modelled on VerseVM's transactional execution. Outside failure contexts
writes go straight through; the happy path has no journaling cost.

### Concurrency

`runtime/scheduler.ts` implements structured concurrency: `Task`s form a
tree; cancelling a task cancels its children and runs its `defer` blocks.
`spawn` / `race` / `sync` / `rush` / `branch` compile directly against the
scheduler. Time comes from a pluggable `Clock`: `RealClock` in the IDE,
`VirtualClock` in tests and benchmarks (sleeps complete instantly in
timestamp order, deterministically).

The `task` and `event` *types* are exposed to programs through the
bindings registry like any other native class — their methods (`Await`,
`Cancel`, `IsComplete`, `Signal`) are native method implementations
declared in `stdlib/simulation.ts`, dispatched at runtime through
`NativeRegistry.resolveValueMethod`.

## The bindings model

Inspired by UE's Verse Native Interface (VNI) "digest" model: native code
publishes a typed, documented surface, and the compiler treats it as a
regular module. In verse-js the entire native surface — standard library,
UEFN extras, and anything an embedder adds — goes through one API in
`bindings/registry.ts`:

```ts
const myModule = defineModule('/MyGame.com/Weather', 'Weather control.', (m) => {
  m.fn(name, signature, impl, doc, example?);      // functions (+ .overload)
  m.cls(name, classInfo, { construct, matches, methods, doc });  // classes
  m.enum(name, enumInfo, doc);                      // enums
  m.value(name, type, value, doc);                  // constants
}, {
  implicit: true,                                   // prelude-style auto-import
  entryPoint: { className, method },                // entry-point protocol
  toleratedRoots: ['/MyGame.com'],                  // warn, don't error, on unknown paths
});
```

Each entry carries three faces:

1. **Checker-facing**: `VType` signatures and effects (via the `T` type
   constructors and `makeEffects`) — how the type checker sees the export.
2. **Runtime-facing**: the `NativeImpl` implementation, `construct` for
   archetype instantiation, `matches` (a runtime type test for non-object
   engine values like tasks), and `methods` (native method dispatch).
3. **Docs-facing**: description/example strings that `docs.ts` turns into
   the IDE docs panel, hovers, and completions — so documentation can
   never go stale relative to the registry.

`declareNativeClass` builds the checker-facing `ClassInfo` for native
classes declaratively (methods, fields, supers, `unique`/`castable`).

### Entry-point protocols

A module can register `{ className, method }`. During checking, any user
class extending `className` is recorded as an entry class; after top-level
statements run, the runtime instantiates each and invokes `method`. This
is how `creative_device.OnBegin` works — declared entirely by the UEFN
extra, with zero compiler knowledge of devices. An embedder can register
its own protocol (e.g. `game_script.Main`) the same way.

### Core vs. extras

The namespace rule: all `/Verse.org/*` modules are core
(`stdlib/`— prelude, Simulation, Concurrency, Random, Colors) and are
registered by every host (unless `includeCore: false`). `/Fortnite.com/*`
and `/UnrealEngine.com/*` live in `extras/uefn.ts` and must be passed in
explicitly — in the spirit of three.js examples/ addons:

```ts
import { uefnModules } from 'verse-js/extras/uefn';
const host = createHost({ modules: uefnModules });
```

The extras are deliberately built **only** with the public bindings API,
which keeps that API honest: anything the UEFN shim needs, an embedder
also has.

## Persistence

Module-scoped `var X : weak_map(key, value)` declarations marked by the
checker as persistable are loaded from the host's `PersistenceAdapter` at
run start (`versemap:<name>` keys, JSON pairs) and flushed back when the
run finishes. The adapter interface is synchronous:

```ts
interface PersistenceAdapter {
  load(key: string): string | null;
  store(key: string, json: string): void;
  clear?(): void; // optional: wipe all persistent data this adapter manages
}
```

Implementations: `MemoryStorageAdapter` (tests/ephemeral),
`LocalStorageAdapter` (the IDE), and `JsonFileStorageAdapter`
(`verse-js/adapters/node`; one JSON object file, lazy read,
write-through). All three implement `clear()`: memory drops its map, the
localStorage adapter removes every key under its prefix (default
`'verse:'`, so unrelated origin data is untouched), and the file adapter
writes an emptied file. The IDE's toolbar Reset button calls `clear()` on
its shared adapter, so resetting the workspace also wipes persistent
weak_map data. Session identity (e.g. `GetLocalPlayer()`) uses stable
`persistKey`s so weak_map entries survive across runs.

## IDE language services

`analysis.ts` provides position-based queries over a compile outcome:
`hoverAt` (checked types/signatures as markdown), `definitionAt`
(declaration `{file, span}` locations recorded on bindings), and
`completionsAt` (all names visible in the scope chain at the cursor,
shadowing respected). The checker records the active `Scope` and resolved
member info on each AST node's `sema` bag while checking, so these
queries are lookups, not re-analysis. `host.analyze(source)` is cheap
enough to run per keystroke; `host.analyzeWorkspace(fs)` returns a
`WorkspaceAnalysis` — one `SourceAnalysis` per file over the shared
module scope, so queries resolve symbols defined in other files. The
Monaco layer analyzes the whole IDE workspace (cached on a workspace
version, with per-file last-good fallbacks so intellisense survives
mid-edit syntax errors) and hands cross-file definition jumps to the IDE
shell, which owns tabs and models.

`docs.ts` generates `ModuleDoc`/`SymbolDoc` structures from a registry —
the docs panel, hover fallbacks, and `using`-path completions all read
from it.

## Extension points (summary)

| You want to... | Use |
| --- | --- |
| Expose native functions/classes/enums/constants to Verse | `defineModule` + `createHost({ modules })` |
| Declare a native class shape for the checker | `declareNativeClass` |
| Dispatch methods on your own engine values | `matches` + `methods` on a class entry |
| Make classes extending yours into program entry points | `entryPoint` module option |
| Auto-import a module into every program | `implicit: true` module option |
| Tolerate unknown module paths under your namespace | `toleratedRoots` module option |
| Store persistent data somewhere custom | implement `PersistenceAdapter` |
| Control time (tests, replays) | pass a `Clock` (e.g. `VirtualClock`) to `run` |
| Deterministic randomness | pass `rng` to `run` |
| Build a debugger UI | implement `DebugHooks` (see `debug/DebugSession.ts`) |
| Build editor tooling | `host.analyze`/`host.analyzeWorkspace` + `hoverAt`/`definitionAt`/`completionsAt`, `host.docs()` |
| Compile a multi-file project | `host.compileWorkspace` with a `SourceFileSystem` (or implement your own) |

## Repository layout

The Next.js IDE (`app/`, `src/ide/`, `src/monaco/`) is a consumer of the
library, importing sources directly via the `@/src/verse/...` alias. The
publishable library build (`pnpm build:lib`, tsup, ESM + `.d.ts` into
`dist/`) covers only `src/verse/**` and has no framework dependencies.
Tests live in `tests/` (vitest): frontend, sema/runtime, conformance
corpus (`tests/conformance/*.verse` golden files), embedding API,
adapters, IDE analysis, plus Playwright E2E for the IDE itself.
