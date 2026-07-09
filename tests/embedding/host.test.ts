// host.test.ts
// The public embedding API: custom native modules via defineModule, custom
// entry-point protocols, host/registry isolation, and the core-vs-extras
// split (a core-only host doesn't know creative_device).

import { describe, expect, it } from 'vitest';
import {
	createHost, declareNativeClass, defineModule, FAIL, T, VObject,
} from '../../src/verse';
import type { Value } from '../../src/verse';
import { uefnModules } from '../../src/verse/extras/uefn';

describe('custom native modules', () => {
	it('exposes functions, values, and enums to Verse code', async () => {
		const calls: number[] = [];
		const weather = defineModule('/MyGame.com/Weather', 'Weather control for tests.', (m) => {
			m.fn('SetRain', { params: [['Intensity', T.int]], ret: T.void },
				(args) => {
					calls.push(args[0] as number);
					return undefined;
				},
				'Sets the rain intensity.');
			m.value('MaxIntensity', T.int, 11, 'The maximum rain intensity.');
			m.enum('season', {
				name: 'season',
				values: ['Spring', 'Summer', 'Fall', 'Winter'],
				open: false,
				modulePath: '/MyGame.com/Weather',
			}, 'The seasons.');
		});

		const host = createHost({ modules: [weather] });
		const result = await host.execute(`using { /MyGame.com/Weather }
SetRain(MaxIntensity)
S := season.Winter
Print("season set")
`);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['season set']);
		expect(calls).toEqual([11]);
	});

	it('supports failable (<decides>) native functions', async () => {
		const parsing = defineModule('/MyGame.com/Parsing', 'Parsing helpers.', (m) => {
			m.fn('ParseInt', { params: [['Text', T.string]], ret: T.int, effects: { decides: true } },
				(args) => {
					const n = Number(args[0] as string);
					return Number.isInteger(n) ? n : FAIL;
				},
				'Parses an integer, failing on non-numeric text.');
		});

		const host = createHost({ modules: [parsing] });
		const result = await host.execute(`using { /MyGame.com/Parsing }
if (N := ParseInt["42"]):
    Print("got {N}")
if (ParseInt["nope"]):
    Print("should not print")
else:
    Print("failed as expected")
`);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['got 42', 'failed as expected']);
	});

	it('supports native classes with native method dispatch', async () => {
		interface CounterHandle { isCounter: true; count: number }
		const isCounter = (v: Value): v is Value & CounterHandle =>
			typeof v === 'object' && v !== null && (v as unknown as CounterHandle).isCounter === true;

		const counterInfo = declareNativeClass({
			name: 'counter',
			methods: [
				{ name: 'Increment', signature: { params: [], ret: T.int } },
				{ name: 'Get', signature: { params: [], ret: T.int } },
			],
		});
		const counters = defineModule('/MyGame.com/Counters', 'Counter objects.', (m) => {
			m.cls('counter', counterInfo, {
				construct: () => ({ isCounter: true, count: 0 } as unknown as Value),
				matches: isCounter,
				methods: {
					Increment: (self) => {
						const c = self as unknown as CounterHandle;
						c.count += 1;
						return c.count;
					},
					Get: (self) => (self as unknown as CounterHandle).count,
				},
				doc: 'A mutable counter.',
			});
		});

		const host = createHost({ modules: [counters] });
		const result = await host.execute(`using { /MyGame.com/Counters }
C := counter{}
C.Increment()
C.Increment()
Print("count is {C.Get()}")
`);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['count is 2']);
	});

	it('registers custom entry-point protocols', async () => {
		const scriptInfo = declareNativeClass({
			name: 'game_script',
			methods: [
				{ name: 'Main', signature: { params: [], ret: T.void, effects: { suspends: true } } },
			],
		});
		const scripting = defineModule('/MyGame.com/Scripting', 'Script entry points.', (m) => {
			m.cls('game_script', scriptInfo, {
				construct: () => new VObject(
					{ name: 'game_script', isStruct: false, conforms: (n) => n === 'game_script' },
					new Map(),
				),
				doc: 'Base class for scripts; Main() runs automatically.',
			});
		}, {
			entryPoint: { className: 'game_script', method: 'Main' },
		});

		const host = createHost({ modules: [scripting] });
		const result = await host.execute(`using { /MyGame.com/Scripting }
my_script := class(game_script):
    Main<override>()<suspends> : void =
        Print("script ran")
`);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['script ran']);
	});

	it('surfaces custom modules in generated docs', () => {
		const custom = defineModule('/MyGame.com/Weather', 'Weather control.', (m) => {
			m.fn('SetRain', { params: [['Intensity', T.int]], ret: T.void },
				() => undefined, 'Sets the rain intensity.');
		});
		const host = createHost({ modules: [custom] });
		const doc = host.docs().find((d) => d.path === '/MyGame.com/Weather');
		expect(doc).toBeDefined();
		expect(doc?.symbols.map((s) => s.name)).toEqual(['SetRain']);
		expect(host.symbolIndex().get('SetRain')?.signature).toBe('SetRain(Intensity: int): void');
	});
});

describe('host isolation and the core/extras split', () => {
	it('keeps registries isolated between hosts', async () => {
		const moduleA = defineModule('/MyGame.com/A', 'A only.', (m) => {
			m.fn('OnlyInA', { params: [], ret: T.int }, () => 1, 'Returns 1.');
		});
		const hostA = createHost({ modules: [moduleA] });
		const hostB = createHost();

		const okInA = await hostA.execute('using { /MyGame.com/A }\nPrint("{OnlyInA()}")');
		expect(okInA.errors).toEqual([]);
		expect(okInA.output).toEqual(['1']);

		const failInB = await hostB.execute('using { /MyGame.com/A }\nPrint("{OnlyInA()}")');
		expect(failInB.errors.some((e) => /Unknown module/.test(e))).toBe(true);
	});

	it('rejects creative_device on a core-only host but accepts it with uefn extras', async () => {
		const source = `using { /Fortnite.com/Devices }
my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        Print("began")
`;
		const coreOnly = createHost();
		const coreResult = await coreOnly.execute(source);
		expect(coreResult.errors.some((e) => /Unknown module/.test(e))).toBe(true);

		const withExtras = createHost({ modules: uefnModules });
		const extrasResult = await withExtras.execute(source);
		expect(extrasResult.errors).toEqual([]);
		expect(extrasResult.output).toEqual(['began']);
	});

	it('warns (instead of erroring) for unmodeled paths under tolerated roots', () => {
		const host = createHost({ modules: uefnModules });
		const outcome = host.compile('using { /Fortnite.com/NotModeled }\nPrint("hi")');
		expect(outcome.ok).toBe(true);
		expect(outcome.diagnostics.some((d) =>
			d.severity === 'warning' && /not modeled/.test(d.message))).toBe(true);

		// Without the extras, the same path is a hard unknown-module error.
		const coreOnly = createHost();
		const coreOutcome = coreOnly.compile('using { /Fortnite.com/NotModeled }\nPrint("hi")');
		expect(coreOutcome.diagnostics.some((d) =>
			d.severity === 'error' && /Unknown module/.test(d.message))).toBe(true);
	});

	it('runs the core stdlib without any extras', async () => {
		const host = createHost();
		const result = await host.execute(`using { /Verse.org/Simulation }
Main()<suspends> : void =
    Sleep(0.0)
    Print("core only")
Main()
`);
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['core only']);
	});
});
