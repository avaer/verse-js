// simulation.ts
// /Verse.org/Simulation: suspending execution, elapsed time, events, tasks,
// and players. The event/task class infos declared here are shared with
// /Verse.org/Concurrency, and their native methods (Await, Cancel, Signal,
// ...) are dispatched through the bindings registry.

import { declareNativeClass, defineModule, T } from '../bindings/registry';
import type { NativeMethodImpl } from '../bindings/registry';
import { Ctx } from '../runtime/context';
import { VerseEvent } from '../runtime/scheduler';
import { FAIL, isEvent, isTask, Value, VObject, VTask } from '../runtime/values';
import { helpers } from './prelude';

// --- class infos (checker-facing shapes, shared across modules) ---

export const eventClassInfo = declareNativeClass({
	name: 'event',
	methods: [
		{ name: 'Signal', signature: { params: [['Payload', T.any]], ret: T.void, effects: { writes: true } } },
		{ name: 'Await', signature: { params: [], ret: T.any, effects: { suspends: true } } },
	],
});

export const taskClassInfo = declareNativeClass({
	name: 'task',
	methods: [
		{ name: 'Await', signature: { params: [], ret: T.any, effects: { suspends: true } } },
		{ name: 'Cancel', signature: { params: [], ret: T.void, effects: { writes: true } } },
		{ name: 'IsComplete', signature: { params: [], ret: T.void, effects: { decides: true } } },
	],
});

export const agentClassInfo = declareNativeClass({
	name: 'agent',
	unique: true,
	castable: true,
});

export const playerClassInfo = declareNativeClass({
	name: 'player',
	supers: [agentClassInfo],
	unique: true,
	castable: true,
});

// --- native method implementations ---

export const taskMethods: Record<string, NativeMethodImpl> = {
	Await: (self, _args, ctx) => ctx.task.suspendable((self as VTask).awaitResult()),
	Cancel: (self) => {
		(self as VTask).cancel();
		return undefined;
	},
	IsComplete: (self) => ((self as VTask).isComplete() ? undefined : FAIL),
};

export const eventMethods: Record<string, NativeMethodImpl> = {
	Signal: (self, args) => {
		(self as VerseEvent).signal(args[0]);
		return undefined;
	},
	Await: (self, _args, ctx) => ctx.task.suspendable((self as VerseEvent).awaitSignal()),
};

// --- session player (stable identity for weak_map persistence) ---

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

export const simulationModule = defineModule(
	'/Verse.org/Simulation',
	'Simulation control: suspending execution, elapsed time, events, tasks, and players.',
	(m) => {
		m.fn('Sleep', { params: [['Seconds', T.float]], ret: T.void, effects: { suspends: true } },
			async (args, ctx) => {
				await ctx.shared.scheduler.sleep(ctx.task, helpers.toFloat(args[0]));
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
			'The player for this session (stand-in for UEFN playspace players; used with weak_map persistence).',
			'ThePlayer := GetLocalPlayer()');

		m.cls('event', eventClassInfo, {
			construct: () => new VerseEvent(),
			matches: isEvent,
			methods: eventMethods,
			doc: 'A signalable event. Await() suspends until Signal(payload) wakes all waiting tasks.',
			example: 'MyEvent := event(int){}\nspawn{ Waiter() }\nMyEvent.Signal(7)',
		});

		m.cls('task', taskClassInfo, {
			matches: isTask,
			methods: taskMethods,
			doc: 'A running async computation, returned by spawn. Await() suspends until it completes; Cancel() stops it.',
			example: 'X := spawn{ DoWork() }\nX.Await()',
		});

		m.cls('player', playerClassInfo, {
			doc: 'A player in the session. Unique and castable; usable as a weak_map key for persistence.',
		});

		m.cls('agent', agentClassInfo, {
			doc: 'Base type for players and AI agents.',
		});
	},
);
