// concurrency.test.ts
// Structured concurrency semantics under the virtual clock: spawn, race,
// sync, rush, branch, task cancellation, defer-on-cancel, and Sleep timing.

import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/verse';
import { testHost } from '../helpers/test-host';

async function run(source: string): Promise<string[]> {
	const outcome = testHost.compile(source, { strict: true });
	if (!outcome.ok) {
		throw new Error(outcome.diagnostics.map((d) => d.message).join('\n'));
	}
	const output: string[] = [];
	const clock = new VirtualClock();
	const handle = testHost.run(outcome, {
		clock,
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			} else if (level === 'error') {
				output.push(`[error] ${text}`);
			}
		},
	});
	await clock.run(handle.done);
	return output;
}

const DEVICE = `using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
`;

describe('sleep ordering', () => {
	it('interleaves tasks by wake time', async () => {
		expect(await run(`${DEVICE}
A()<suspends> : void =
    Sleep(1.0)
    Print("A at 1s")
    Sleep(2.0)
    Print("A at 3s")
B()<suspends> : void =
    Sleep(2.0)
    Print("B at 2s")
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        TA := spawn{ A() }
        TB := spawn{ B() }
        TA.Await()
        TB.Await()
        Print("done at {GetSimulationElapsedTime()}s")
`)).toEqual(['A at 1s', 'B at 2s', 'A at 3s', 'done at 3.0s']);
	});
});

describe('race', () => {
	it('cancels the loser at its next suspension', async () => {
		expect(await run(`${DEVICE}
Fast()<suspends> : string =
    Sleep(1.0)
    "fast"
Slow()<suspends> : string =
    Sleep(10.0)
    Print("slow finished (should not happen)")
    "slow"
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Winner := race:
            Fast()
            Slow()
        Print("winner: {Winner}")
        Print("time: {GetSimulationElapsedTime()}s")
`)).toEqual(['winner: fast', 'time: 1.0s']);
	});

	it('runs loser defer blocks on cancellation', async () => {
		expect(await run(`${DEVICE}
Fast()<suspends> : string =
    Sleep(1.0)
    "fast"
Slow()<suspends> : string =
    defer:
        Print("slow cleaned up")
    Sleep(10.0)
    "slow"
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Winner := race:
            Fast()
            Slow()
        Print("winner: {Winner}")
`)).toEqual(['winner: fast', 'slow cleaned up']);
	});
});

describe('sync', () => {
	it('waits for the slowest clause', async () => {
		expect(await run(`${DEVICE}
my_device := class(creative_device):
    Delayed(Seconds : float, Result : int)<suspends> : int =
        Sleep(Seconds)
        Result
    OnBegin<override>()<suspends> : void =
        Results := sync:
            Delayed(3.0, 1)
            Delayed(1.0, 2)
        Print("{Results(0)} {Results(1)} at {GetSimulationElapsedTime()}s")
`)).toEqual(['1 2 at 3.0s']);
	});
});

describe('rush', () => {
	it('returns the first result and lets the rest continue', async () => {
		expect(await run(`${DEVICE}
my_device := class(creative_device):
    Quick()<suspends> : string =
        Sleep(1.0)
        "quick"
    Slow()<suspends> : string =
        Sleep(2.0)
        Print("slow still finished")
        "slow"
    OnBegin<override>()<suspends> : void =
        First := rush:
            Quick()
            Slow()
        Print("first: {First}")
        Sleep(5.0)
`)).toEqual(['first: quick', 'slow still finished']);
	});
});

describe('branch', () => {
	it('cancels branch work when the enclosing scope exits', async () => {
		expect(await run(`${DEVICE}
my_device := class(creative_device):
    Background()<suspends> : void =
        loop:
            Sleep(1.0)
            Print("tick")
    Work()<suspends> : void =
        branch:
            Background()
        Sleep(2.5)
        Print("work done")
    OnBegin<override>()<suspends> : void =
        Work()
        Sleep(3.0)
        Print("after work")
`)).toEqual(['tick', 'tick', 'work done', 'after work']);
	});
});

describe('task control', () => {
	it('Cancel() stops a spawned task', async () => {
		expect(await run(`${DEVICE}
Ticker()<suspends> : void =
    loop:
        Sleep(1.0)
        Print("tick")
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Ticker() }
        Sleep(2.5)
        T.Cancel()
        Sleep(2.0)
        Print("end")
`)).toEqual(['tick', 'tick', 'end']);
	});

	it('IsComplete decides', async () => {
		expect(await run(`${DEVICE}
Work()<suspends> : void =
    Sleep(1.0)
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        T := spawn{ Work() }
        if (T.IsComplete[]):
            Print("already done?")
        else:
            Print("still running")
        T.Await()
        if (T.IsComplete[]):
            Print("now done")
`)).toEqual(['still running', 'now done']);
	});
});

describe('events', () => {
	it('Signal wakes all waiters with the payload', async () => {
		expect(await run(`${DEVICE}
my_device := class(creative_device):
    Door : event(int) = event(int){}
    Waiter(Name : string)<suspends> : void =
        Code := Door.Await()
        Print("{Name} got {Code}")
    OnBegin<override>()<suspends> : void =
        T1 := spawn{ Waiter("first") }
        T2 := spawn{ Waiter("second") }
        Sleep(0.0)
        Door.Signal(42)
        T1.Await()
        T2.Await()
`)).toEqual(['first got 42', 'second got 42']);
	});
});
