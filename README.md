# verse-js

An **embeddable JavaScript/TypeScript runtime** for
[Verse](https://dev.epicgames.com/documentation/en-us/uefn/verse-language-reference),
Epic Games' programming language for UEFN/Fortnite — plus a self-contained
**browser IDE** that edits, runs, and debugs Verse with no backend and no
UEFN install. It ships a full implementation of the core language: a
hand-written lexer and parser, a type/effect checker, a closure-compiling
runtime with transactional failure semantics, structured concurrency, and a
source-level debugger.

![Verse IDE](https://img.shields.io/badge/verse-ide-3fa7ff) ![Next.js 16](https://img.shields.io/badge/next.js-16-black) ![React 19](https://img.shields.io/badge/react-19-61dafb)

The project is two things:

1. **A library** (`verse-js`) you can embed in your own app or engine: an
   isolated *host* with a public *bindings API* for exposing your own native
   modules to Verse code, pluggable storage adapters, and IDE-grade language
   services (diagnostics, hover, go-to-definition, completions).
2. **An IDE** (this repo's Next.js app) built entirely on that public API —
   the Fortnite/UEFN shims it uses are an optional *extra*, not part of the
   core runtime.

## Embedding quickstart

```ts
import { createHost } from 'verse-js';
import { uefnModules } from 'verse-js/extras/uefn';   // optional UEFN shims
import { MemoryStorageAdapter } from 'verse-js/adapters';

const host = createHost({
  modules: uefnModules,                     // optional extras (three.js-style)
  persistence: new MemoryStorageAdapter(),  // storage for weak_map persistence
});

// One-shot: compile (strict) + run to completion.
const { output, errors, diagnostics } = await host.execute(`
  Print("Hello from Verse")
`);

// Or stage it: compile once, inspect diagnostics, run with options.
const outcome = host.compile(source);
if (outcome.ok) {
  const run = host.run(outcome, {
    onOutput: (level, text) => console.log(level, text),
  });
  await run.done;      // run.stop() cancels all tasks
}

// IDE services, generated from this host's registry:
const docs = host.docs();               // browsable module documentation
const analysis = host.analyze(source);  // hoverAt / definitionAt / completionsAt
```

Hosts are isolated: each `createHost` call gets its own bindings registry,
so two hosts never share modules or state.

### Defining your own native modules (the bindings API)

Everything the runtime exposes to Verse code goes through `defineModule` —
including the bundled standard library and the UEFN extras, so the API
surface you use is the one the project itself is built on:

```ts
import { createHost, defineModule, declareNativeClass, T, FAIL } from 'verse-js';

const weather = defineModule('/MyGame.com/Weather', 'Weather control.', (m) => {
  m.fn('SetRain', { params: [['Intensity', T.float]], ret: T.void },
    ([intensity]) => { engine.setRain(intensity as number); return undefined; },
    'Sets the rain intensity from 0.0 to 1.0.');

  // <decides> (failable) functions return FAIL to fail the surrounding context.
  m.fn('GetZone', { params: [['Name', T.string]], ret: T.int, effects: { decides: true } },
    ([name]) => engine.findZone(name as string) ?? FAIL,
    'Looks up a zone by name; fails when it does not exist.');

  m.value('MaxIntensity', T.float, 1.0, 'Maximum rain intensity.');
});

const host = createHost({ modules: [weather] });
await host.execute(`
  using { /MyGame.com/Weather }
  SetRain(0.5)
`);
```

Modules can also contribute **native classes** (with runtime method
dispatch), **enums**, **entry-point protocols** (e.g. "classes extending
`creative_device` run `OnBegin`"), implicit (prelude) imports, and
tolerated namespace roots. See
[ARCHITECTURE.md](ARCHITECTURE.md#the-bindings-model) for the full model
and `tests/embedding/host.test.ts` for working examples of each.

### Package entry points

| Entry | Contents |
| --- | --- |
| `verse-js` | `createHost`, the bindings API, stdlib, docs generation, language services |
| `verse-js/extras/uefn` | Optional `/Fortnite.com/Devices` + `/UnrealEngine.com/...Diagnostics` shims |
| `verse-js/adapters` | `MemoryStorageAdapter`, `LocalStorageAdapter` |
| `verse-js/adapters/node` | `JsonFileStorageAdapter` (Node `fs`; kept out of browser bundles) |
| `verse-js/analysis` | Position-based IDE queries (`hoverAt`, `definitionAt`, `completionsAt`) |

`pnpm build:lib` produces the publishable ESM build with `.d.ts` in `dist/`.

## The IDE

- **Monaco editor** with the official Verse TextMate grammar, live
  diagnostics as squiggles (error-recovering parser + type/effect checker),
  checker-backed hover/go-to-definition, and scope-aware completions
- **Run button** (F5): lex → parse → check → compile to JS closures →
  execute, with output streaming into the console panel. Straight-line code
  runs synchronously; execution only goes async at real suspension points
  (`Sleep`, `Await`, concurrency blocks)
- **Debugger**: click the gutter to set breakpoints, then Debug to pause with
  a variables panel, call stack, and live task list; Step Over / Step Into /
  Step Out / Continue; Stop cancels any run, including mid-`Sleep` and
  infinite `loop:`
- **Verse failure semantics**: failure contexts (`if` conditions, `or`
  left-hand sides, `not`, `<decides>` bodies, loop filters) run
  speculatively — every write is journaled and rolled back on failure,
  modelled on VerseVM's transactional execution
- **Structured concurrency**: `spawn`, `race`, `sync`, `rush`, `branch`,
  `task` / `event` values, cancellation running `defer` blocks, and a
  simulation clock (virtual in tests, real-time in the IDE)
- **The type system**: classes / interfaces / structs with inheritance and
  overrides, parametric functions and classes (`where t : type`), enums,
  options (`?t`, `option{}`, postfix `?`), unions, aliases, `unique` /
  `castable` classes with `X[e]` casts, extension methods, overloading
- **Persistence**: module-scoped `var X : weak_map(player, t)` survives runs
  via the localStorage adapter, with `<persistable>` validation; the toolbar
  Reset button clears it (`PersistenceAdapter.clear()`)
- **Browsable builtin docs**: the docs panel, hovers, and completions are all
  generated from the host's bindings registry, so they never go stale
- Multi-file workspace (create/rename/delete `.verse` files) persisted to
  localStorage, resizable panes, streaming console with timestamps and
  click-to-jump error locations

## Getting started

```bash
pnpm install
pnpm dev        # landing page at http://localhost:3000, IDE at /editor
pnpm test       # vitest suite (frontend/sema/runtime/conformance/embedding)
pnpm build:lib  # library build (ESM + .d.ts) to dist/
pnpm bench      # micro-benchmarks for the closure-compiled runtime
pnpm build      # IDE production build
pnpm test:e2e   # Playwright end-to-end tests against the IDE
```

The editor seeds these example files:

| File | Demonstrates |
| --- | --- |
| `hello-world.verse` | `creative_device` + `OnBegin` entry point, `Print`, string interpolation |
| `failure-rollback.verse` | `<decides>` functions, failure contexts, transactional rollback |
| `sleep-countdown.verse` | `Sleep` + `loop:`/`break`, real-time output, Stop mid-run |
| `random-dice.verse` | `/Verse.org/Random` natives, `for` ranges — good breakpoint demo |
| `shapes-classes.verse` | classes, inheritance, overrides, enums, `case`, dynamic casts |
| `race-and-sync.verse` | `race`/`sync`/`spawn`, cancellation, `defer`, simulation time |
| `generics-options.verse` | parametric functions, option types, extension methods |
| `persistent-score.verse` | `weak_map(player, int)` persistence across runs |

## Language coverage

The implementation follows Epic's public compiler source (the keyword table
and effect set are taken from `ReservedSymbols.inl` / `Effects.h` on the
`ue6-main` stream) and the UEFN Verse language reference:

- **Blocks**: significant indentation, braced blocks, and `;`-separated
  one-liners; specifiers (`<decides>`, `<transacts>`, `<override>`, ...);
  attributes (`@editable`, `@doc`)
- **Types**: `int`, `float`, `rational`, `logic`, `char`, `string`, `void`,
  `any`, `comparable`, arrays, maps, tuples, options, functions as values
- **Effects**: the 8 fundamental effects with specifier aliases, bottom-up
  inference, and call-site legality checks (e.g. no `suspends` calls inside a
  failure context)
- **Documented deviations**: `int` is a JS number (loses precision past
  2^53)
- **Parsed but rejected** (same as shipping Verse): reserved-future syntax
  such as `await`, `upon`, `generator`, `dictate`

Namespace rule for the core/extras split: everything under `/Verse.org/*`
is core and always registered; `/Fortnite.com/*` and `/UnrealEngine.com/*`
live in `verse-js/extras/uefn`. Explicit non-goals: full Fortnite/UEFN
device and player APIs (the extra is a tiny shim: `creative_device`,
`player`, `GetLocalPlayer`), client prediction, distributed transactions.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full tour (pipeline stages,
value/transaction model, concurrency, the bindings/digest model, the
persistence flow, and every extension point). The short version:

```
src/verse/            the embeddable library (framework-free, Node + browser)
  frontend/           lexer.ts, parser.ts (recursive descent, error
                      recovery), ast.ts, printer.ts
  sema/               checker.ts, types.ts (lattice + subtyping),
                      effects.ts, scopes.ts (slot allocation)
  runtime/            compile-closures.ts (AST -> JS closure tree with a
                      synchronous fast path), values.ts, failure.ts
                      (transaction journal), scheduler.ts (tasks, events,
                      virtual/real clocks)
  bindings/           the public bindings API: defineModule, ModuleBuilder,
                      declareNativeClass, NativeRegistry
  stdlib/             /Verse.org/* core modules, built via the bindings API
  extras/uefn.ts      optional /Fortnite.com + /UnrealEngine.com shims
  adapters/           storage adapters (memory, localStorage; node.ts: fs)
  host.ts             createHost / VerseHost: compile, run, execute, docs,
                      analyze
  analysis.ts         position-based IDE queries over checker results
  docs.ts             documentation generation from a registry
  debug/              DebugSession.ts (breakpoints, stepping, variable +
                      task snapshots; hooks compiled in only for Debug runs)
src/monaco/           Monaco loader config, TextMate registration,
                      intellisense providers backed by the IDE host
src/ide/              React components: Ide shell, EditorPane, Console,
                      DebugPanel, DocsPanel, FileSidebar, EditorTabs, Toolbar
app/                  Next.js app router entry (IDE is client-only)
```

Run mode compiles without debug hooks, so plain execution pays nothing for
the debugger; Debug mode recompiles with per-statement hooks. Transaction
journaling is only active inside failure contexts — the happy path writes
directly.

## Attribution

The Monaco TextMate assets are vendorized from
[johanfortus/Verse-Online-Editor](https://github.com/johanfortus/Verse-Online-Editor)
(MIT License). The language implementation (lexer, parser, checker, closure
compiler, scheduler, transaction system) is original to this repo, with
semantics cross-checked against the VerseVM sources in Epic Games' public
Unreal Engine stream and the UEFN documentation. Verse is a trademark of
Epic Games; this project is unaffiliated with Epic Games.
