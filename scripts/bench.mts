// bench.mts
// Micro-benchmarks for the closure-compiled Verse runtime.
// Run with: pnpm bench
// Each case reports total wall time; use these numbers to decide whether a
// bytecode backend is ever worth it (see the plan's performance section).

import { createHost, startRun, VirtualClock } from '../src/verse/index';
import { uefnModules } from '../src/verse/extras/uefn';

const host = createHost({ modules: uefnModules });

interface Bench {
	name: string;
	source: string;
	/** Expected last line of output, as a sanity check. */
	expect?: RegExp;
}

const BENCHES: Bench[] = [
	{
		name: 'fib(24) recursive',
		expect: /^46368$/,
		source: `
Fib(N : int) : int =
    if (N < 2) then N else Fib(N - 1) + Fib(N - 2)
Print("{Fib(24)}")
`,
	},
	{
		// Appending to an array is O(n) (value semantics), so this is
		// intentionally quadratic; it measures array copy throughput.
		name: 'array churn (build + sum 10k, quadratic)',
		expect: /^333383335000$/,
		source: `
var Items : []int = array{}
for (I := 1..10000):
    set Items += array{I * I}
var Total : int = 0
for (X : Items):
    set Total += X
Print("{Total}")
`,
	},
	{
		name: 'map churn (20k inserts + lookups)',
		expect: /^19999$/,
		source: `
var M : [int]int = map{}
for (I := 0..19999):
    if (set M[I] = I * 2) {}
var Hits : int = 0
for (I := 0..19999):
    if (V := M[I], V = I * 2):
        set Hits += 1
Print("{Hits - 1}")
`,
	},
	{
		name: 'failure contexts (100k speculative rollbacks)',
		expect: /^50000$/,
		source: `
Even(X : int)<decides> : int =
    var Y : int = X
    set Y += 1
    Mod[X, 2] = 0
    Y
var Count : int = 0
for (I := 1..100000):
    if (Even[I]):
        set Count += 1
Print("{Count}")
`,
	},
	{
		name: 'concurrency stress (2k tasks x 3 sleeps)',
		expect: /^done 2000$/,
		source: `
using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
Worker(N : int)<suspends> : int =
    Sleep(1.0)
    Sleep(1.0)
    Sleep(1.0)
    N
bench_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        var Done : int = 0
        sync:
            block:
                for (I := 1..1000):
                    T := spawn{ Worker(I) }
                    T.Await()
                    set Done += 1
            block:
                for (I := 1..1000):
                    T := spawn{ Worker(I) }
                    T.Await()
                    set Done += 1
        Print("done {Done}")
`,
	},
];

async function runBench(bench: Bench): Promise<void> {
	// Front end + checker, timed separately from execution.
	const compileStart = performance.now();
	const outcome = host.compile(bench.source, { strict: true });
	if (!outcome.ok) {
		console.error(`  COMPILE FAILED: ${outcome.diagnostics.map((d) => d.message).join('; ')}`);
		process.exitCode = 1;
		return;
	}
	// Closure compilation is part of the compile cost embedders pay.
	const compiled = host.prepare(outcome);
	const compileMs = performance.now() - compileStart;

	const output: string[] = [];
	const clock = new VirtualClock();
	const start = performance.now();
	const run = startRun(compiled, {
		clock,
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			} else if (level === 'error') {
				console.error(`  runtime error: ${text}`);
				process.exitCode = 1;
			}
		},
	});
	await clock.run(run.done);
	const elapsed = performance.now() - start;
	const last = output[output.length - 1] ?? '(no output)';
	const ok = bench.expect ? bench.expect.test(last) : true;
	if (!ok) {
		process.exitCode = 1;
	}
	console.log(
		`${ok ? 'ok  ' : 'FAIL'} ${bench.name.padEnd(45)}` +
		` compile ${compileMs.toFixed(1).padStart(7)} ms` +
		`   run ${elapsed.toFixed(1).padStart(9)} ms   (${last})`,
	);
}

console.log('verse-js benchmarks (closure compiler, virtual clock)\n');
for (const bench of BENCHES) {
	await runBench(bench);
}
