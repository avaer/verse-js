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

The compiler applies a set of static specializations on top of that:

- **Sync-first combinators**: all expression combinators — binary, calls
  (without named arguments), member reads, blocks, argument lists,
  if/case arms, and/or/not/query, unary, tuple/map/range literals, and
  archetypes — evaluate through loops/branches that allocate no
  continuation closures on the all-synchronous path; promise
  continuations are only built when an operand actually suspends.
- **Transaction elision**: the checker watches each failure context for
  journal-relevant writes (an explicit observer stack fed by `set`s and,
  conservatively, calls to functions whose effects include writes) and
  stamps the result on the node; read-only contexts compile to a plain
  fail-check with no `Transaction`. Writing contexts keep full
  journaling, and the journal's entries array is allocated lazily on the
  first recorded write.
- **Context-local write elision**: a `set` to a local declared in the
  same frame at the same failure-context depth skips journaling entirely
  — any open transaction predates the slot, so rollback never needs to
  restore it (the common case: locals of a `<decides>` function body).
  Such writes also don't count toward transaction elision above, so
  conditions that only mutate their own locals compile with no
  transaction at all.
- **Copy-on-write appends**: containers are uniqueness-tracked (a
  WeakSet of possibly-aliased arrays/maps, marked at every store site
  that can create a second reference, with fresh constructor results
  exempt). `set X += array{...}` / map merges mutate in place while the
  target is unaliased — O(1) instead of O(n) per append — journaled via
  array-length / map-entry entries; aliased targets keep the copying
  semantics.
- **Inline caches + method-call fusion**: dynamic member sites carry a
  per-site two-way polymorphic cache keyed on class identity (classes
  are immutable after compile, so no invalidation; a miss shifts entry 1
  down and refills entry 0). `obj.Method(args)` resolves through the
  cache and invokes with `self = obj` directly, eliminating the per-call
  bound-function allocation; bare method reads (`obj.Method` as a value)
  still bind. Field reads use a single Map lookup (the `has` check only
  runs for a stored void).
- **Hoisted continuations**: statement wrappers are fused into the block
  loop (one line-stamp and fail-check inline per statement, no wrapper
  call), and the hot combinators (`if` clause chains, failure contexts,
  `set`/definition stores, loop bodies) run their synchronous path with
  zero per-evaluation closures — the async tails live in shared
  module-level helpers that are only entered when something suspends.
- **Range-loop fast path**: `for (I := lo..hi): body` with no filters
  compiles to a plain numeric loop with no generator bookkeeping, no
  iterables array, and no per-iteration collector closure; statement-
  position loops skip result collection entirely.
- **Call binding, refined**: parameters whose static type can never hold
  a struct skip the per-call `copyIfStruct` instanceof check, and the
  body runner (return-signal handling) is built once per function
  definition — simple functions (no `branch`, no debug) run without the
  per-call `finish` closure.
- **Operator specialization**: when both operand types are statically
  numeric (or both strings), operators compile to monomorphic
  implementations with no runtime type dispatch; int/int division keeps
  exact quotients as plain numbers and only allocates a `VRational` for
  fractional results.
- **Lazy ranges**: `for (I := lo..hi)` iterates numerically without
  materializing the range as an array; zero-filter loops skip the filter
  and transaction machinery entirely.
- **Call binding**: functions whose parameters are all positional with no
  defaults bind arguments through a specialized fast path with no
  per-parameter branching.
- **Two-tier map keys**: `VMap` uses primitive keys (int/float/string/
  logic/void, integral rationals) directly as JS Map keys; structural
  keys are canonicalized once and interned to per-map tokens (see
  Values).
- **Batched persistence**: writes to persistable `weak_map`s mark the map
  dirty and serialize once per microtask instead of re-serializing the
  whole map on every `set`; the end-of-run flush drains anything still
  pending, so `await run.done` always observes persisted state.

Measured effect on the micro-benchmarks (`pnpm bench`, virtual clock,
same machine; run time only — compile stayed ~1–5 ms throughout).
Optimization pass 1 (sync-first core, transaction elision, operator
specialization, lazy ranges, call binding, two-tier keys):

| bench                                | before   | after    |
| ------------------------------------ | -------- | -------- |
| fib(24) recursive                    | 218.3 ms | 120.5 ms |
| array churn (10k, quadratic)         | 52.1 ms  | 27.6 ms  |
| map churn (20k inserts + lookups)    | 130.5 ms | 48.1 ms  |
| failure contexts (100k rollbacks)    | 314.5 ms | 136.9 ms |
| concurrency stress (2k tasks × 3)    | 24.3 ms  | 20.3 ms  |

Optimization pass 2 (context-local elision, copy-on-write appends,
inline caches / call fusion, remaining sync-first combinators, batched
persistence):

| bench                                | before   | after    |
| ------------------------------------ | -------- | -------- |
| array churn (10k)                    | 27.6 ms  | 6.1 ms   |
| array append (100k, in-place) — new  | (O(n²))  | 12.4 ms  |
| OO dispatch (200k calls) — new       | 87.7 ms  | 72.0 ms  |
| fib / map churn / failure / conc.    | ~flat    | ~flat    |

The copy-on-write change moved list building from quadratic to linear
(the churn bench changed complexity class; 100k appends complete in
~12 ms where copying took minutes). Inline caches were kept after
measuring −18% on the OO dispatch bench (median of 12 in-process runs);
the remaining benches were flat within noise. Context-local elision
removed per-write journal entries but the failure-context bench is
dominated by transaction setup and call overhead, so its headline
number barely moved; the win shows up in conditions that only mutate
their own locals, which now compile with no transaction at all.

Optimization pass 3 (hoisted continuations / fused statement wrappers,
range-loop fast path, refined call binding, single-lookup field reads,
two-way polymorphic caches). Two harness notes first: `pnpm bench` now
bundles with esbuild and runs under plain node — the previous `tsx`
loader injected a `__name` keep-names shim into every compiled closure
that accounted for roughly a third of measured time, so pass-3 numbers
are not comparable to the tables above (the pass-1/2 tables were
self-consistent, both measured under tsx). Cold single-shot runs also
carry ±20% JIT noise, so decisions were gated on warm in-process
medians (`scripts/oo-median.mts`, 15 runs).

| bench (bundled, single-shot)         | before   | after    |
| ------------------------------------ | -------- | -------- |
| fib(24) recursive                    | ~28 ms   | ~19 ms   |
| failure contexts (100k rollbacks)    | ~32 ms   | ~25 ms   |
| OO dispatch (200k calls)             | ~41 ms   | ~36 ms   |
| polymorphic dispatch — new           | —        | ~32 ms   |
| array append (100k, in-place)        | ~12 ms   | ~9 ms    |
| array churn / map churn / conc.      | ~flat    | ~flat    |

On warm medians the two-way polymorphic cache cut the new mixed-site
dispatch bench from 19.5–20.8 ms to ~16.7 ms (~15%) with no regression
on monomorphic sites, and single-lookup field reads were a consistent
~4% on the OO bench. One negative result, kept out: pooling
`Transaction` objects through a free list measured flat (24.7 ms vs
25.5 ms median on the failure bench, within noise) — the objects are
two-field allocations that V8's young generation already handles well,
so the added release bookkeeping wasn't worth it. The main remaining
per-call cost is the argument-array allocation in the calling
convention (`invoke(self, args)`); removing it needs arity-specialized
invoke entry points and is recorded here as future work.

### Values

`runtime/values.ts` defines the value model: JS numbers/strings/booleans
for scalars, `VRational`, `VOption`, `VTuple`, `VMap`, `VObject`/`VStruct`
(structs get value semantics — copied on assignment), `VFunctionValue`
(bound methods), and first-class type values (`VTypeValue`,
`RuntimeClass`, `NativeClassValue`) that serve as cast targets
(`shape[X]`) and archetype constructors (`shape{...}`).

`VMap` is insertion-ordered with two-tier structural keys: primitive keys
are used directly as JS Map keys, while structural keys (arrays, tuples,
options, structs, ...) are canonicalized via `canonicalKey` once and
interned to a per-map token object, so equal-by-value keys hit the same
entry and raw string keys can never collide with a structural encoding.

### Failure semantics and transactions

Failable expressions return the `FAIL` sentinel instead of throwing.
Failure contexts (`if` conditions, `or` left sides, `not`, `<decides>`
bodies, loop filters) open a `Transaction` (`runtime/failure.ts`): every
mutation inside is journaled, and on failure the journal rolls back —
modelled on VerseVM's transactional execution. Outside failure contexts
writes go straight through; the happy path has no journaling cost.
Contexts the checker proved read-only skip the transaction entirely (see
Closure compilation), the journal allocates lazily on first write, and
writes to locals declared inside the same context skip journaling — the
slot postdates every open transaction, so rollback never restores it.

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
