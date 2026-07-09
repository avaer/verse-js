// DebugController behavior: breakpoints, stepping, scope snapshots,
// cancellation (Stop), and Sleep interruption.
import { describe, expect, it } from 'vitest';
import { compileVerse } from '../src/verse/compile.js';
import { VerseInterpreter } from '../src/verse/interpreter.js';
import { DebugController } from '../src/verse/debug/DebugController.js';
import { VerseRunCancelled } from '../src/verse/runtime/failure.js';

const COUNT_SOURCE = `using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    OnBegin<override>()<suspends>:void=
        var Total : int = 0
        for (Index := 1..3):
            set Total += Index
        Print("Total {Total}")
`;

function setup(source, controllerOptions) {
	const compiled = compileVerse(source);
	expect(compiled.ok).toBe(true);
	const controller = new DebugController({
		lineMap: compiled.lineMap,
		...controllerOptions,
	});
	const outputs = [];
	const interpreter = new VerseInterpreter({
		onOutput: (line) => outputs.push(line),
		controller,
	});
	return { compiled, controller, interpreter, outputs };
}

describe('DebugController', () => {
	it('pauses on a breakpoint with a scope snapshot, then resumes to completion', async () => {
		const pauses = [];
		let controllerRef;
		const { compiled, controller, interpreter, outputs } = setup(COUNT_SOURCE, {
			debugEnabled: true,
			breakpoints: [9], // `set Total += Index`
			onPaused: (info) => {
				pauses.push(info);
				// resume asynchronously so the await chain settles
				setTimeout(() => controllerRef.resume(), 0);
			},
		});
		controllerRef = controller;

		await interpreter.interpret(compiled.ast);

		// The for loop runs 3 iterations; the breakpoint line is hit each time.
		expect(pauses.length).toBe(3);
		expect(pauses[0].line).toBe(9);

		const totalVar = pauses[1].variables.find((v) => v.name === 'Total');
		expect(totalVar).toBeDefined();
		expect(totalVar.value).toBe('1'); // after first iteration, before second add

		expect(outputs).toEqual(['Total 6']);
	});

	it('ignores breakpoints when debugEnabled is false', async () => {
		const pauses = [];
		const { compiled, interpreter, outputs } = setup(COUNT_SOURCE, {
			debugEnabled: false,
			breakpoints: [9],
			onPaused: (info) => pauses.push(info),
		});

		await interpreter.interpret(compiled.ast);

		expect(pauses.length).toBe(0);
		expect(outputs).toEqual(['Total 6']);
	});

	it('steps to the next statement with stepInto', async () => {
		const pausedLines = [];
		let controllerRef;
		let stepsRemaining = 2;
		const { compiled, controller, interpreter } = setup(COUNT_SOURCE, {
			debugEnabled: true,
			breakpoints: [7], // `var Total : int = 0`
			onPaused: (info) => {
				pausedLines.push(info.line);
				setTimeout(() => {
					if (stepsRemaining-- > 0) {
						controllerRef.stepInto();
					} else {
						controllerRef.resume();
					}
				}, 0);
			},
		});
		controllerRef = controller;

		await interpreter.interpret(compiled.ast);

		// break at line 7, step to the for at line 8, step into first set at 9
		expect(pausedLines.slice(0, 3)).toEqual([7, 8, 9]);
	});

	it('cancel() unwinds an infinite loop with VerseRunCancelled', async () => {
		const source = `using { /Fortnite.com/Devices }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    OnBegin<override>()<suspends>:void=
        var X : int = 0
        loop:
            set X += 1
`;
		const { compiled, controller, interpreter } = setup(source, {});

		setTimeout(() => controller.cancel(), 50);
		await expect(interpreter.interpret(compiled.ast)).rejects.toBeInstanceOf(VerseRunCancelled);
	});

	it('cancel() interrupts a long Sleep immediately', async () => {
		const source = `using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }
using { /UnrealEngine.com/Temporary/Diagnostics }

device := class(creative_device):

    OnBegin<override>()<suspends>:void=
        Print("before sleep")
        Sleep(60.0)
        Print("after sleep")
`;
		const { compiled, controller, interpreter, outputs } = setup(source, {});

		const started = Date.now();
		setTimeout(() => controller.cancel(), 30);
		await expect(interpreter.interpret(compiled.ast)).rejects.toBeInstanceOf(VerseRunCancelled);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(outputs).toEqual(['before sleep']);
	});
});
