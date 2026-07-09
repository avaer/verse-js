// concurrency.ts
// /Verse.org/Concurrency: exposes the event/task types. The expression
// forms (spawn, race, sync, rush, branch) are language builtins compiled
// directly against the scheduler.

import { defineModule } from '../bindings/registry';
import { VerseEvent } from '../runtime/scheduler';
import { isEvent, isTask } from '../runtime/values';
import {
	eventClassInfo, eventMethods, taskClassInfo, taskMethods,
} from './simulation';

export const concurrencyModule = defineModule(
	'/Verse.org/Concurrency',
	'Concurrency primitives. The expression forms (spawn, race, sync, rush, branch) are built into the language; this module exposes the event and task types.',
	(m) => {
		m.cls('event', eventClassInfo, {
			construct: () => new VerseEvent(),
			matches: isEvent,
			methods: eventMethods,
			doc: 'A signalable event. Await() suspends until Signal(payload) wakes all waiting tasks.',
		});
		m.cls('task', taskClassInfo, {
			matches: isTask,
			methods: taskMethods,
			doc: 'A running async computation, returned by spawn.',
		});
	},
);
