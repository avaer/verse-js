// Dedicated A/B instrument: run one bench source many times in-process and
// report the median run time (throwaway measurement tool).
import { createHost, startRun, VirtualClock } from '../src/verse/index';
import { uefnModules } from '../src/verse/extras/uefn';

const which = process.argv[2] ?? 'oo';

const SOURCES: Record<string, string> = {
	oo: `
shape := class:
    Scale : int = 1
    Area() : int = 0
square := class(shape):
    Side : int = 2
    Area<override>() : int = Side * Side * Scale
circle := class(shape):
    R : int = 3
    Area<override>() : int = 3 * R * R * Scale
Total() : int =
    S := square{Side := 4}
    C := circle{R := 5}
    var Acc : int = 0
    for (I := 1..100000):
        set Acc += S.Area() + C.Area() + S.Scale
    Acc
Print("{Total()}")
`,
	fib: `
Fib(N : int) : int =
    if (N < 2) then N else Fib(N - 1) + Fib(N - 2)
Print("{Fib(24)}")
`,
	failure: `
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
	map: `
var M : [int]int = map{}
for (I := 0..19999):
    if (set M[I] = I * 2) {}
var Hits : int = 0
for (I := 0..19999):
    if (V := M[I], V = I * 2):
        set Hits += 1
Print("{Hits - 1}")
`,
};

const host = createHost({ modules: uefnModules });
const outcome = host.compile(SOURCES[which], { strict: true });
if (!outcome.ok) {
	console.error(outcome.diagnostics.map((d) => d.message).join('; '));
	process.exit(1);
}
const compiled = host.prepare(outcome);

const times: number[] = [];
for (let i = 0; i < 15; i++) {
	const clock = new VirtualClock();
	const start = performance.now();
	const run = startRun(compiled, { clock, onOutput: () => {} });
	await clock.run(run.done);
	times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`${which}: median ${median.toFixed(1)} ms, min ${times[0].toFixed(1)} ms  (${times.map((t) => t.toFixed(0)).join(' ')})`);
