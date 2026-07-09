# verse-js

A self-contained browser IDE that edits, **runs, and debugs**
[Verse](https://dev.epicgames.com/documentation/en-us/uefn/verse-language-reference),
Epic Games' programming language for UEFN/Fortnite — no backend, no UEFN
install, everything happens in the browser tab. It ships a full
implementation of the core language: a hand-written lexer and parser, a
type/effect checker, a closure-compiling runtime with transactional failure
semantics, structured concurrency, and a source-level debugger.

![Verse IDE](https://img.shields.io/badge/verse-ide-3fa7ff) ![Next.js 16](https://img.shields.io/badge/next.js-16-black) ![React 19](https://img.shields.io/badge/react-19-61dafb)

## Features

- **Monaco editor** with the official Verse TextMate grammar (full syntax
  highlighting via `vscode-textmate` + `vscode-oniguruma`), live diagnostics
  as squiggles (error-recovering parser + type/effect checker), hover docs,
  and completions for every builtin
- **Run button** (F5): lex → parse → check → compile to JS closures →
  execute, with output streaming into the console panel. Straight-line code
  runs synchronously (no per-statement awaits); execution only goes async at
  real suspension points (`Sleep`, `Await`, concurrency blocks)
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
  via localStorage, with `<persistable>` validation
- **Browsable builtin docs**: the docs panel, hovers, and completions are all
  generated from the native module registry, so they never go stale
- Multi-file workspace (create/rename/delete `.verse` files) persisted to
  localStorage, resizable panes, streaming console with timestamps and
  click-to-jump error locations

## Getting started

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # vitest suite (lexer/parser/checker/runtime/concurrency/debug)
pnpm bench      # micro-benchmarks for the closure-compiled runtime
pnpm build      # production build
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
  2^53); integral floats print without a trailing `.0`
- **Parsed but rejected** (same as shipping Verse): reserved-future syntax
  such as `await`, `upon`, `generator`, `dictate`

Explicit non-goals: Fortnite/UEFN device and player APIs
(`/Fortnite.com/...` is a tiny shim: `creative_device`, `player`,
`GetLocalPlayer`), client prediction, distributed transactions.

## Architecture

```
src/verse/            language core (framework-free, runs in Node + browser)
  frontend/           lexer.ts, parser.ts (recursive descent, error
                      recovery), ast.ts, printer.ts
  sema/               checker.ts, types.ts (lattice + subtyping),
                      effects.ts, scopes.ts (slot allocation)
  runtime/            compile-closures.ts (AST -> JS closure tree with a
                      synchronous fast path), values.ts, failure.ts
                      (transaction journal), scheduler.ts (tasks, events,
                      virtual/real clocks), natives/ (module registry +
                      the /Verse.org core library with docs metadata)
  debug/              DebugSession.ts (breakpoints, stepping, variable +
                      task snapshots; hooks compiled in only for Debug runs)
  pipeline.ts         one entry point: compileVerse / startRun / runVerse
src/monaco/           Monaco loader config, TextMate registration,
                      intellisense (hover/completions from the registry)
src/ide/              React components: Ide shell, EditorPane, Console,
                      DebugPanel, DocsPanel, FileSidebar, EditorTabs, Toolbar
app/                  Next.js app router entry (IDE is client-only)
scripts/bench.mts     fib / array churn / map churn / rollback /
                      concurrency micro-benchmarks (pnpm bench)
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
