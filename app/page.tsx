// Landing page: what verse-js is (a Verse implementation in JavaScript),
// the embedding API, and the feature set. The IDE itself lives at /editor.

import Link from "next/link";

const GITHUB_URL = "https://github.com/avaer/verse-js";

function CodeBlock({
  title,
  code,
}: {
  title: string;
  code: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[#2d2d2d] bg-[#1e1e1e]">
      <div className="flex items-center gap-2 border-b border-[#2d2d2d] px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#3fa7ff]/60" />
        <span className="font-mono text-xs text-[#8a8a8a]">{title}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-[#d4d4d4]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#2d2d2d] bg-[#1e1e1e] p-5">
      <h3 className="mb-2 text-sm font-semibold text-[#e8e8e8]">{title}</h3>
      <p className="text-[13px] leading-relaxed text-[#9a9a9a]">{children}</p>
    </div>
  );
}

const VERSE_SAMPLE = `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

vault := class:
    var Gold : int = 100

    Withdraw(Amount : int)<decides><transacts> : int =
        Amount <= Gold
        set Gold -= Amount
        Amount

my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        TheVault := vault{}
        if (Taken := TheVault.Withdraw[30]):
            Print("Withdrew {Taken} gold")
        if (TheVault.Withdraw[999]):
            Print("big spender!")
        else:
            Print("Rolled back - still {TheVault.Gold} gold")`;

const QUICKSTART = `import { createHost } from 'verse-js';
import { uefnModules } from 'verse-js/extras/uefn';   // optional UEFN shims
import { MemoryStorageAdapter } from 'verse-js/adapters';

const host = createHost({
  modules: uefnModules,                     // optional extras
  persistence: new MemoryStorageAdapter(),  // weak_map storage
});

// One-shot: compile (strict) + run to completion.
const { output, errors } = await host.execute('Print("Hello from Verse")');

// Or stage it: compile, inspect diagnostics, run with options.
const outcome = host.compile(source);
if (outcome.ok) {
  const run = host.run(outcome, {
    onOutput: (level, text) => console.log(level, text),
  });
  await run.done;   // run.stop() cancels all tasks
}`;

const BINDINGS = `import { createHost, defineModule, T, FAIL } from 'verse-js';

const weather = defineModule('/MyGame.com/Weather', 'Weather control.', (m) => {
  m.fn('SetRain', { params: [['Intensity', T.float]], ret: T.void },
    ([intensity]) => { engine.setRain(intensity as number); return undefined; },
    'Sets the rain intensity from 0.0 to 1.0.');

  // <decides> natives return FAIL to fail the surrounding context.
  m.fn('GetZone', { params: [['Name', T.string]], ret: T.int,
      effects: { decides: true } },
    ([name]) => engine.findZone(name as string) ?? FAIL,
    'Looks up a zone by name; fails when it does not exist.');
});

const host = createHost({ modules: [weather] });
await host.execute(\`
  using { /MyGame.com/Weather }
  SetRain(0.5)
\`);`;

const IDE_SERVICES = `const docs = host.docs();              // generated module documentation
const analysis = host.analyze(source); // per-keystroke semantic analysis

hoverAt(analysis, line, col);          // checked types and signatures
definitionAt(analysis, line, col);     // go-to-definition spans
completionsAt(analysis, line, col);    // scope-aware completions`;

export default function Home() {
  return (
    <div className="min-h-dvh overflow-y-auto bg-[#181818] text-[#cccccc]">
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b border-[#2d2d2d] bg-[#181818]/95 backdrop-blur">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="font-mono text-sm font-semibold text-[#e8e8e8]">
            verse-js
          </Link>
          <div className="flex items-center gap-5 text-[13px]">
            <a href="#features" className="text-[#9a9a9a] transition-colors hover:text-[#e8e8e8]">
              Features
            </a>
            <a href="#api" className="text-[#9a9a9a] transition-colors hover:text-[#e8e8e8]">
              API
            </a>
            <a
              href={GITHUB_URL}
              className="text-[#9a9a9a] transition-colors hover:text-[#e8e8e8]"
            >
              GitHub
            </a>
            <Link
              href="/editor"
              className="rounded-md bg-[#3fa7ff] px-3 py-1.5 font-medium text-[#0b1c2b] transition-colors hover:bg-[#66b9ff]"
            >
              Open Editor
            </Link>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
        {/* Hero */}
        <section className="pb-14 pt-16 sm:pt-24">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-[#3fa7ff]">
            A Verse implementation in JavaScript
          </p>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight text-[#f0f0f0] sm:text-5xl">
            Run Epic Games&rsquo; Verse language anywhere JavaScript runs.
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[#9a9a9a]">
            verse-js is an embeddable runtime for{" "}
            <a
              href="https://dev.epicgames.com/documentation/en-us/uefn/verse-language-reference"
              className="text-[#3fa7ff] hover:underline"
            >
              Verse
            </a>{" "}
            — a hand-written lexer and parser, a type and effect checker, a
            closure-compiling runtime with transactional failure semantics,
            structured concurrency, and a source-level debugger. No backend, no
            UEFN install: it runs in the browser and in Node.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/editor"
              className="rounded-md bg-[#3fa7ff] px-5 py-2.5 text-sm font-semibold text-[#0b1c2b] transition-colors hover:bg-[#66b9ff]"
            >
              Try it in the editor
            </Link>
            <a
              href={GITHUB_URL}
              className="rounded-md border border-[#3d3d3d] px-5 py-2.5 text-sm font-medium text-[#cccccc] transition-colors hover:border-[#5a5a5a] hover:text-[#e8e8e8]"
            >
              View on GitHub
            </a>
            <code className="ml-1 rounded-md border border-[#2d2d2d] bg-[#1e1e1e] px-3 py-2 font-mono text-xs text-[#9a9a9a]">
              npm install verse-js
            </code>
          </div>
        </section>

        {/* Code sample */}
        <section className="grid gap-4 pb-16 lg:grid-cols-[3fr_2fr]">
          <CodeBlock title="failure-rollback.verse" code={VERSE_SAMPLE} />
          <div className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-lg border border-[#2d2d2d] bg-[#1e1e1e]">
              <div className="border-b border-[#2d2d2d] px-4 py-2 font-mono text-xs text-[#8a8a8a]">
                console
              </div>
              <pre className="p-4 font-mono text-[12.5px] leading-relaxed text-[#89d185]">
                {"Withdrew 30 gold\nRolled back - still 70 gold"}
              </pre>
            </div>
            <p className="px-1 text-[13px] leading-relaxed text-[#9a9a9a]">
              Failure contexts run speculatively: every write inside a{" "}
              <code className="font-mono text-xs text-[#cccccc]">
                &lt;decides&gt;
              </code>{" "}
              call is journaled and rolled back when the expression fails —
              modelled on VerseVM&rsquo;s transactional execution. The failed
              999-gold withdrawal above leaves the vault untouched.
            </p>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-16 pb-16">
          <h2 className="mb-6 text-2xl font-bold text-[#f0f0f0]">Features</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Feature title="Transactional failure semantics">
              Failable expressions, failure contexts, and speculative execution
              with journaled rollback — <code>if</code> conditions,{" "}
              <code>or</code> left-hand sides, <code>not</code>, and{" "}
              <code>&lt;decides&gt;</code> bodies behave like real Verse.
            </Feature>
            <Feature title="Structured concurrency">
              <code>spawn</code>, <code>race</code>, <code>sync</code>,{" "}
              <code>rush</code>, <code>branch</code>, task and event values,
              cancellation running <code>defer</code> blocks, and a pluggable
              simulation clock (virtual in tests, real-time in the IDE).
            </Feature>
            <Feature title="Type and effect checker">
              Classes, interfaces, structs, parametric types with{" "}
              <code>where t : type</code>, enums, options, unions, casts, and
              the eight fundamental Verse effects inferred bottom-up and
              enforced at call sites.
            </Feature>
            <Feature title="Source-level debugger">
              Breakpoints, Step Over / Into / Out, variables, call stack, and a
              live task list. Debug hooks are compiled in only for debug runs —
              plain execution pays nothing.
            </Feature>
            <Feature title="Embeddable host API">
              <code>createHost</code> gives you an isolated compile / run /
              execute pipeline. Expose your own native modules through the same
              bindings API the standard library uses.
            </Feature>
            <Feature title="Fast closure compilation">
              The AST compiles to JavaScript closures with a synchronous fast
              path — sequential Verse code runs without per-statement async
              overhead, only suspending at real suspension points.
            </Feature>
            <Feature title="Persistence adapters">
              Module-scoped <code>weak_map</code> variables persist across runs
              through a two-method storage interface: in-memory, localStorage,
              or a JSON file in Node.
            </Feature>
            <Feature title="IDE-grade language services">
              Live diagnostics from an error-recovering parser, checker-backed
              hovers, go-to-definition, scope-aware completions, and browsable
              docs generated from the bindings registry.
            </Feature>
            <Feature title="Optional UEFN extras">
              <code>/Fortnite.com/Devices</code> and friends ship as a separate
              entry point built on the public bindings API — the core runtime
              has no Fortnite dependency.
            </Feature>
          </div>
        </section>

        {/* API */}
        <section id="api" className="scroll-mt-16 pb-16">
          <h2 className="mb-2 text-2xl font-bold text-[#f0f0f0]">The API</h2>
          <p className="mb-6 max-w-2xl text-[13px] leading-relaxed text-[#9a9a9a]">
            Everything goes through a <em>host</em>: an isolated environment
            holding a bindings registry plus the compile/run pipeline and IDE
            services over it. Two hosts never share modules or state.
          </p>

          <div className="space-y-8">
            <div>
              <h3 className="mb-3 text-base font-semibold text-[#e8e8e8]">
                1. Create a host, compile, run
              </h3>
              <CodeBlock title="quickstart.ts" code={QUICKSTART} />
            </div>

            <div>
              <h3 className="mb-3 text-base font-semibold text-[#e8e8e8]">
                2. Bind your own native modules
              </h3>
              <p className="mb-3 max-w-2xl text-[13px] leading-relaxed text-[#9a9a9a]">
                The bindings API is how the standard library and the UEFN
                extras are built, so it is the same surface any embedder gets:
                functions with overloads and effects, native classes with
                runtime method dispatch, enums, constants, entry-point
                protocols, and implicit (prelude) imports.
              </p>
              <CodeBlock title="bindings.ts" code={BINDINGS} />
            </div>

            <div>
              <h3 className="mb-3 text-base font-semibold text-[#e8e8e8]">
                3. Build tooling on the language services
              </h3>
              <CodeBlock title="ide-services.ts" code={IDE_SERVICES} />
            </div>

            <div>
              <h3 className="mb-3 text-base font-semibold text-[#e8e8e8]">
                Package entry points
              </h3>
              <div className="overflow-hidden rounded-lg border border-[#2d2d2d]">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-[#2d2d2d] bg-[#1e1e1e] text-[#8a8a8a]">
                      <th className="px-4 py-2.5 font-medium">Entry</th>
                      <th className="px-4 py-2.5 font-medium">Contents</th>
                    </tr>
                  </thead>
                  <tbody className="text-[#9a9a9a]">
                    {[
                      ["verse-js", "createHost, the bindings API, stdlib, docs generation"],
                      ["verse-js/analysis", "hoverAt, definitionAt, completionsAt"],
                      ["verse-js/extras/uefn", "Optional /Fortnite.com + /UnrealEngine.com shims"],
                      ["verse-js/adapters", "MemoryStorageAdapter, LocalStorageAdapter"],
                      ["verse-js/adapters/node", "JsonFileStorageAdapter (kept out of browser bundles)"],
                    ].map(([entry, contents]) => (
                      <tr key={entry} className="border-b border-[#2d2d2d] last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-[#3fa7ff]">{entry}</td>
                        <td className="px-4 py-2.5">{contents}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[13px] text-[#9a9a9a]">
                Full details in the repo&rsquo;s{" "}
                <a
                  href={`${GITHUB_URL}/blob/master/README.md`}
                  className="text-[#3fa7ff] hover:underline"
                >
                  README
                </a>{" "}
                and{" "}
                <a
                  href={`${GITHUB_URL}/blob/master/ARCHITECTURE.md`}
                  className="text-[#3fa7ff] hover:underline"
                >
                  ARCHITECTURE
                </a>{" "}
                docs.
              </p>
            </div>
          </div>
        </section>

        {/* Editor CTA */}
        <section className="pb-20">
          <div className="rounded-lg border border-[#2d2d2d] bg-[#1e1e1e] p-8 text-center">
            <h2 className="text-xl font-bold text-[#f0f0f0]">
              The whole thing runs in your browser tab.
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-[#9a9a9a]">
              The editor ships eight example files covering failure rollback,
              concurrency, generics, classes, and persistence — with
              breakpoints, stepping, and browsable builtin docs.
            </p>
            <Link
              href="/editor"
              className="mt-5 inline-block rounded-md bg-[#3fa7ff] px-6 py-2.5 text-sm font-semibold text-[#0b1c2b] transition-colors hover:bg-[#66b9ff]"
            >
              Open the editor
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-[#2d2d2d]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-[#7a7a7a]">
          <span>
            Verse is a trademark of Epic Games. This project is unaffiliated
            with Epic Games.
          </span>
          <div className="flex gap-4">
            <Link href="/editor" className="hover:text-[#cccccc]">
              Editor
            </Link>
            <a href={GITHUB_URL} className="hover:text-[#cccccc]">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
