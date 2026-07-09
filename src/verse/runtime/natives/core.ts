// core.ts
// The Verse.org core library natives (no Fortnite device APIs): prelude
// math/string/container functions, Random, Simulation (Sleep, events,
// tasks, players), and Concurrency. Every entry carries docs metadata that
// the IDE surfaces automatically.

import { makeClassInfo, T, FuncT, ClassInfo } from '../../sema/types';
import { makeEffects } from '../../sema/effects';
import { VerseRuntimeError } from '../failure';
import { VerseEvent } from '../scheduler';
import {
	asRational, FAIL, Value, verseToDiagnostic, verseToString, VObject, VOption,
	VRational, isTask, isEvent, VMap,
} from '../values';
import { Ctx } from '../context';
import { ModuleBuilder, NativeRegistry } from './registry';

function method(params: [string, ReturnType<() => typeof T.int>][], ret: typeof T.int, effects: Parameters<typeof makeEffects>[0] = {}): FuncT {
	return {
		k: 'func',
		params: params.map(([name, type]) => ({ name, type, named: false, hasDefault: false })),
		ret,
		effects: makeEffects(effects),
		typeParams: [],
	};
}

function addMethod(info: ClassInfo, name: string, type: FuncT): void {
	info.members.set(name, {
		name, type, mutable: false, access: 'public', isMethod: true, hasBody: true, origin: info,
	});
}

// --- native class infos (shared with the checker) ---

export const eventClassInfo = makeClassInfo('event', 'class');
eventClassInfo.native = true;
addMethod(eventClassInfo, 'Signal', method([['Payload', T.any]], T.void, { writes: true }));
addMethod(eventClassInfo, 'Await', method([], T.any, { suspends: true }));

export const taskClassInfo = makeClassInfo('task', 'class');
taskClassInfo.native = true;
addMethod(taskClassInfo, 'Await', method([], T.any, { suspends: true }));
addMethod(taskClassInfo, 'Cancel', method([], T.void, { writes: true }));
addMethod(taskClassInfo, 'IsComplete', method([], T.void, { decides: true }));

export const playerClassInfo = makeClassInfo('player', 'class');
playerClassInfo.native = true;
playerClassInfo.unique = true;
playerClassInfo.castable = true;

export const agentClassInfo = makeClassInfo('agent', 'class');
agentClassInfo.native = true;
agentClassInfo.unique = true;
agentClassInfo.castable = true;
playerClassInfo.supers.push(agentClassInfo);

export const creativeDeviceClassInfo = makeClassInfo('creative_device', 'class');
creativeDeviceClassInfo.native = true;
addMethod(creativeDeviceClassInfo, 'OnBegin', method([], T.void, { suspends: true }));
addMethod(creativeDeviceClassInfo, 'OnEnd', method([], T.void));

const num = (v: Value): number => v as number;

function intCheck(v: number, what: string): number {
	if (!Number.isFinite(v)) {
		throw new VerseRuntimeError(`${what} produced a non-finite int`);
	}
	return v;
}

function toFloat(v: Value): number {
	if (v instanceof VRational) {
		return v.toFloat();
	}
	return v as number;
}

// =====================================================================
// /Verse.org/Verse (implicit prelude)
// =====================================================================

function buildPrelude(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/Verse.org/Verse',
		'The Verse prelude: printing, math, and container helpers. Always in scope.',
	);

	m.fn('Print', { params: [['Message', T.string]], ret: T.void },
		(args, ctx) => {
			ctx.shared.out('stdout', verseToString(args[0]));
			return undefined;
		},
		'Writes a message to the log/console.',
		'Print("Hello, world!")');

	m.fn('ToString', { params: [['Value', T.any]], ret: T.string },
		(args) => verseToString(args[0]),
		'Converts a value to its string representation.',
		'Print(ToString(42))');

	m.fn('ToDiagnostic', { params: [['Value', T.any]], ret: T.string },
		(args) => verseToDiagnostic(args[0]),
		'Converts any value to a diagnostic (debug) string.',
		'Print(ToDiagnostic(array{1, 2}))');

	m.fn('Abs', { params: [['X', T.int]], ret: T.int },
		(args) => {
			const v = args[0];
			if (v instanceof VRational) {
				return new VRational(Math.abs(v.num), v.den);
			}
			return Math.abs(num(v));
		},
		'Absolute value.', 'Abs(-5) = 5');
	m.overload('Abs', { params: [['X', T.float]], ret: T.float });
	m.overload('Abs', { params: [['X', T.rational]], ret: T.rational });

	m.fn('Floor', { params: [['X', T.float]], ret: T.int },
		(args) => {
			const v = args[0];
			return v instanceof VRational ? v.floor() : Math.floor(num(v));
		},
		'Rounds down to the nearest integer.', 'Floor(2.7) = 2');
	m.overload('Floor', { params: [['X', T.rational]], ret: T.int });

	m.fn('Ceil', { params: [['X', T.float]], ret: T.int },
		(args) => {
			const v = args[0];
			return v instanceof VRational ? v.ceil() : Math.ceil(num(v));
		},
		'Rounds up to the nearest integer.', 'Ceil(2.1) = 3');
	m.overload('Ceil', { params: [['X', T.rational]], ret: T.int });

	m.fn('Round', { params: [['X', T.float]], ret: T.int },
		(args) => {
			const v = args[0];
			return v instanceof VRational ? Math.round(v.toFloat()) : Math.round(num(v));
		},
		'Rounds to the nearest integer.', 'Round(2.5) = 3');
	m.overload('Round', { params: [['X', T.rational]], ret: T.int });

	m.fn('Int', { params: [['X', T.float]], ret: T.int, effects: { decides: true } },
		(args) => {
			const v = toFloat(args[0]);
			return Number.isInteger(v) ? v : FAIL;
		},
		'Failable conversion to int; succeeds only when the value is integral.',
		'if (N := Int[4.0]) { Print("{N}") }');
	m.overload('Int', { params: [['X', T.rational]], ret: T.int, effects: { decides: true } });

	m.fn('ToFloat', { params: [['X', T.int]], ret: T.float },
		(args) => toFloat(args[0]),
		'Converts an int or rational to float.', 'ToFloat(3) = 3.0');
	m.overload('ToFloat', { params: [['X', T.rational]], ret: T.float });

	m.fn('Sqrt', { params: [['X', T.float]], ret: T.float },
		(args) => Math.sqrt(num(args[0])),
		'Square root.', 'Sqrt(9.0) = 3.0');

	m.fn('Pow', { params: [['Base', T.float], ['Exponent', T.float]], ret: T.float },
		(args) => Math.pow(num(args[0]), num(args[1])),
		'Raises Base to Exponent.', 'Pow(2.0, 10.0) = 1024.0');

	m.fn('Exp', { params: [['X', T.float]], ret: T.float },
		(args) => Math.exp(num(args[0])), 'e raised to X.');
	m.fn('Ln', { params: [['X', T.float]], ret: T.float, effects: { decides: true } },
		(args) => (num(args[0]) > 0 ? Math.log(num(args[0])) : FAIL),
		'Natural logarithm; fails for non-positive values.', 'if (L := Ln[2.718]) {}');
	m.fn('Sin', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.sin(num(args[0])), 'Sine of an angle in radians.');
	m.fn('Cos', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.cos(num(args[0])), 'Cosine of an angle in radians.');
	m.fn('Tan', { params: [['Radians', T.float]], ret: T.float }, (args) => Math.tan(num(args[0])), 'Tangent of an angle in radians.');
	m.fn('ArcTan', { params: [['Y', T.float], ['X', T.float]], ret: T.float }, (args) => Math.atan2(num(args[0]), num(args[1])), 'Two-argument arctangent.');

	m.fn('Min', { params: [['A', T.int], ['B', T.int]], ret: T.int },
		(args) => {
			const [a, b] = args;
			if (a instanceof VRational || b instanceof VRational) {
				return asRational(a).compare(asRational(b)) <= 0 ? a : b;
			}
			return Math.min(num(a), num(b));
		},
		'The smaller of two values.', 'Min(3, 7) = 3');
	m.overload('Min', { params: [['A', T.float], ['B', T.float]], ret: T.float });

	m.fn('Max', { params: [['A', T.int], ['B', T.int]], ret: T.int },
		(args) => {
			const [a, b] = args;
			if (a instanceof VRational || b instanceof VRational) {
				return asRational(a).compare(asRational(b)) >= 0 ? a : b;
			}
			return Math.max(num(a), num(b));
		},
		'The larger of two values.', 'Max(3, 7) = 7');
	m.overload('Max', { params: [['A', T.float], ['B', T.float]], ret: T.float });

	m.fn('Clamp', { params: [['X', T.int], ['Low', T.int], ['High', T.int]], ret: T.int },
		(args) => Math.min(Math.max(num(args[0]), num(args[1])), num(args[2])),
		'Clamps X into [Low, High].', 'Clamp(12, 0, 10) = 10');
	m.overload('Clamp', { params: [['X', T.float], ['Low', T.float], ['High', T.float]], ret: T.float });

	m.fn('Mod', { params: [['X', T.int], ['Y', T.int]], ret: T.int, effects: { decides: true } },
		(args) => {
			const y = num(args[1]);
			if (y === 0) {
				return FAIL;
			}
			return num(args[0]) % y;
		},
		'Remainder of X / Y; fails when Y = 0.', 'if (R := Mod[7, 3]) { Print("{R}") }');

	m.fn('Quotient', { params: [['X', T.int], ['Y', T.int]], ret: T.int, effects: { decides: true } },
		(args) => {
			const y = num(args[1]);
			if (y === 0) {
				return FAIL;
			}
			return Math.trunc(num(args[0]) / y);
		},
		'Integer division of X by Y, truncated toward zero; fails when Y = 0.',
		'if (Q := Quotient[7, 2]) { Print("{Q}") }');

	m.fn('Concatenate', { params: [['Left', T.array(T.any)], ['Right', T.array(T.any)]], ret: T.array(T.any) },
		(args) => {
			const a = args[0];
			const b = args[1];
			if (typeof a === 'string' && typeof b === 'string') {
				return a + b;
			}
			return ([] as Value[]).concat(a as Value[], b as Value[]);
		},
		'Concatenates two arrays (or strings).', 'Concatenate(array{1}, array{2}) = array{1, 2}');
	m.overload('Concatenate', { params: [['Left', T.string], ['Right', T.string]], ret: T.string });

	m.fn('ConcatenateMaps', { params: [['Left', T.map(T.comparable, T.any)], ['Right', T.map(T.comparable, T.any)]], ret: T.map(T.comparable, T.any) },
		(args) => {
			const left = args[0] as VMap;
			const right = args[1] as VMap;
			const result = left.clone();
			for (const [key, value] of right.pairs()) {
				result.set(key, value);
			}
			return result;
		},
		'Merges two maps; entries in Right win on key collisions.',
		'ConcatenateMaps(map{1 => "a"}, map{2 => "b"})');

	m.fn('Length', { params: [['Text', T.string]], ret: T.int },
		(args) => {
			const v = args[0];
			if (typeof v === 'string') {
				return v.length;
			}
			if (Array.isArray(v)) {
				return v.length;
			}
			if (v instanceof VMap) {
				return v.size;
			}
			return 0;
		},
		'Length of a string or array (also available as .Length).');

	m.fn('ToUpper', { params: [['Text', T.string]], ret: T.string },
		(args) => (args[0] as string).toUpperCase(),
		'Uppercases a string.', 'ToUpper("verse") = "VERSE"');

	m.fn('ToLower', { params: [['Text', T.string]], ret: T.string },
		(args) => (args[0] as string).toLowerCase(),
		'Lowercases a string.', 'ToLower("VERSE") = "verse"');

	m.fn('Contains', { params: [['Text', T.string], ['Substring', T.string]], ret: T.void, effects: { decides: true } },
		(args) => ((args[0] as string).includes(args[1] as string) ? undefined : FAIL),
		'Succeeds when Text contains Substring.', 'if (Contains["hello", "ell"]) {}');

	m.fn('Split', { params: [['Text', T.string], ['Separator', T.string]], ret: T.array(T.string) },
		(args) => (args[0] as string).split(args[1] as string),
		'Splits Text on every occurrence of Separator.',
		'Split("a,b,c", ",") = array{"a", "b", "c"}');

	m.fn('Join', { params: [['Parts', T.array(T.string)], ['Separator', T.string]], ret: T.string },
		(args) => (args[0] as Value[]).map((p) => verseToString(p)).join(args[1] as string),
		'Joins an array of strings with a separator.',
		'Join(array{"a", "b"}, "-") = "a-b"');

	m.fn('Reverse', { params: [['Items', T.array(T.any)]], ret: T.array(T.any) },
		(args) => {
			const v = args[0];
			if (typeof v === 'string') {
				return [...v].reverse().join('');
			}
			return [...(v as Value[])].reverse();
		},
		'A new array (or string) with the elements in reverse order.',
		'Reverse(array{1, 2, 3}) = array{3, 2, 1}');
	m.overload('Reverse', { params: [['Text', T.string]], ret: T.string });

	m.fn('Keys', { params: [['Map', T.map(T.comparable, T.any)]], ret: T.array(T.comparable) },
		(args) => [...(args[0] as VMap).pairs()].map(([k]) => k),
		'The keys of a map, in insertion order.', 'Keys(map{1 => "a"}) = array{1}');

	m.fn('Values', { params: [['Map', T.map(T.comparable, T.any)]], ret: T.array(T.any) },
		(args) => [...(args[0] as VMap).pairs()].map(([, v]) => v),
		'The values of a map, in insertion order.', 'Values(map{1 => "a"}) = array{"a"}');

	return m;
}

// =====================================================================
// /Verse.org/Colors (handy for console demos)
// =====================================================================

function buildColors(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/Verse.org/Colors',
		'Named colors as hex strings, plus helpers to build them. In UEFN these are color values; here they are handy for console demos.',
	);
	m.fn('MakeColorFromHex', { params: [['Hex', T.string]], ret: T.string, effects: { decides: true } },
		(args) => {
			const hex = args[0] as string;
			return /^#?[0-9A-Fa-f]{6}$/.test(hex) ? (hex.startsWith('#') ? hex : `#${hex}`) : FAIL;
		},
		'Validates and normalizes a #RRGGBB hex color string.',
		'if (C := MakeColorFromHex["FF8800"]) { Print(C) }');
	const named: [string, string][] = [
		['White', '#FFFFFF'], ['Black', '#000000'], ['Red', '#FF0000'],
		['Green', '#00FF00'], ['Blue', '#0000FF'], ['Yellow', '#FFFF00'],
		['Cyan', '#00FFFF'], ['Magenta', '#FF00FF'], ['Orange', '#FF8800'],
		['Purple', '#8800FF'],
	];
	for (const [name, hex] of named) {
		m.value(name, T.string, hex, `The color ${name.toLowerCase()} (${hex}).`);
	}
	return m;
}

// =====================================================================
// /Verse.org/Random
// =====================================================================

function buildRandom(): ModuleBuilder {
	const m = new ModuleBuilder('/Verse.org/Random', 'Pseudo-random number generation.');

	m.fn('GetRandomInt', { params: [['Min', T.int], ['Max', T.int]], ret: T.int },
		(args, ctx) => {
			const min = Math.ceil(num(args[0]));
			const max = Math.floor(num(args[1]));
			return intCheck(min + Math.floor(ctx.shared.rng() * (max - min + 1)), 'GetRandomInt');
		},
		'A uniformly random int in [Min, Max] (inclusive).',
		'Roll := GetRandomInt(1, 6)');

	m.fn('GetRandomFloat', { params: [['Min', T.float], ['Max', T.float]], ret: T.float },
		(args, ctx) => num(args[0]) + ctx.shared.rng() * (num(args[1]) - num(args[0])),
		'A uniformly random float in [Min, Max).',
		'X := GetRandomFloat(0.0, 1.0)');

	m.fn('Shuffle', { params: [['Items', T.array(T.any)]], ret: T.array(T.any) },
		(args, ctx) => {
			const result = [...(args[0] as Value[])];
			for (let i = result.length - 1; i > 0; i--) {
				const j = Math.floor(ctx.shared.rng() * (i + 1));
				[result[i], result[j]] = [result[j], result[i]];
			}
			return result;
		},
		'A new array with the elements in random order.',
		'Shuffled := Shuffle(array{1, 2, 3})');

	return m;
}

// =====================================================================
// /Verse.org/Simulation
// =====================================================================

function getSessionPlayer(ctx: Ctx): Value {
	const shared = ctx.shared as unknown as { sessionPlayer?: Value };
	if (!shared.sessionPlayer) {
		const runtimeClass = {
			name: 'player',
			isStruct: false,
			conforms: (n: string) => n === 'player' || n === 'agent',
		};
		const player = new VObject(runtimeClass, new Map());
		// Stable identity so weak_map persistence survives across runs.
		player.persistKey = 'player:local';
		shared.sessionPlayer = player;
	}
	return shared.sessionPlayer;
}

function buildSimulation(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/Verse.org/Simulation',
		'Simulation control: suspending execution, elapsed time, events, tasks, and players.',
	);

	m.fn('Sleep', { params: [['Seconds', T.float]], ret: T.void, effects: { suspends: true } },
		async (args, ctx) => {
			await ctx.shared.scheduler.sleep(ctx.task, toFloat(args[0]));
			return undefined;
		},
		'Suspends the current task for the given number of seconds (0.0 yields one tick).',
		'Sleep(1.0)');

	m.fn('GetSimulationElapsedTime', { params: [], ret: T.float },
		(_args, ctx) => ctx.shared.scheduler.clock.now(),
		'Seconds elapsed since the simulation (run) started.',
		'Now := GetSimulationElapsedTime()');

	m.fn('GetLocalPlayer', { params: [], ret: T.classType(playerClassInfo) },
		(_args, ctx) => getSessionPlayer(ctx),
		'The player for this IDE session (stand-in for UEFN playspace players; used with weak_map persistence).',
		'ThePlayer := GetLocalPlayer()');

	m.cls('event', eventClassInfo, () => new VerseEvent(),
		'A signalable event. Await() suspends until Signal(payload) wakes all waiting tasks.',
		'MyEvent := event(int){}\nspawn{ Waiter() }\nMyEvent.Signal(7)');

	m.cls('task', taskClassInfo, null,
		'A running async computation, returned by spawn. Await() suspends until it completes; Cancel() stops it.',
		'X := spawn{ DoWork() }\nX.Await()');

	m.cls('player', playerClassInfo, null,
		'A player in the session. Unique and castable; usable as a weak_map key for persistence.');

	m.cls('agent', agentClassInfo, null,
		'Base type for players and AI agents.');

	return m;
}

// =====================================================================
// /Verse.org/Concurrency (aliases of the Simulation event/task types)
// =====================================================================

function buildConcurrency(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/Verse.org/Concurrency',
		'Concurrency primitives. The expression forms (spawn, race, sync, rush, branch) are built into the language; this module exposes the event and task types.',
	);
	m.cls('event', eventClassInfo, () => new VerseEvent(),
		'A signalable event. Await() suspends until Signal(payload) wakes all waiting tasks.');
	m.cls('task', taskClassInfo, null,
		'A running async computation, returned by spawn.');
	return m;
}

// =====================================================================
// /Fortnite.com/Devices (minimal shim so UEFN-style programs run)
// =====================================================================

function buildDevices(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/Fortnite.com/Devices',
		'Minimal creative_device shim: subclass it and override OnBegin as your program entry point. Full Fortnite device APIs are out of scope for this environment.',
	);
	m.cls('creative_device', creativeDeviceClassInfo,
		() => new VObject({ name: 'creative_device', isStruct: false, conforms: (n) => n === 'creative_device' }, new Map()),
		'Base class for device scripts. Override OnBegin<override>()<suspends> to run code.',
		'my_device := class(creative_device):\n    OnBegin<override>()<suspends> : void =\n        Print("Hello!")');
	return m;
}

// =====================================================================
// /UnrealEngine.com/Temporary/Diagnostics (Print lives here in UEFN)
// =====================================================================

function buildDiagnostics(): ModuleBuilder {
	const m = new ModuleBuilder(
		'/UnrealEngine.com/Temporary/Diagnostics',
		'Debug output. In UEFN this module provides Print; here Print is also available without any import.',
	);
	m.fn('Print', { params: [['Message', T.string]], ret: T.void },
		(args, ctx) => {
			ctx.shared.out('stdout', verseToString(args[0]));
			return undefined;
		},
		'Writes a message to the log/console.',
		'Print("Hello, world!")');
	return m;
}

// =====================================================================

export function buildNativeRegistry(): NativeRegistry {
	const registry = new NativeRegistry();
	registry.add(buildPrelude());
	registry.add(buildRandom());
	registry.add(buildSimulation());
	registry.add(buildConcurrency());
	registry.add(buildColors());
	registry.add(buildDevices());
	registry.add(buildDiagnostics());
	return registry;
}

export const builtinMemberDispatch = {
	isTask,
	isEvent,
	VOption,
};
