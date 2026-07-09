// effects.ts
// Verse effect system model. The 8 fundamental effects mirror Epic's
// uLang/Semantics/Effects.h (VERSE_ENUM_EFFECTS): suspends, decides,
// diverges, reads, writes, allocates, dictates, no_rollback. Specifier
// keywords (<transacts>, <computes>, ...) are aliases that set/clear whole
// effect families.

import { Specifier } from '../frontend/ast';

export interface EffectSet {
	suspends: boolean;
	decides: boolean;
	diverges: boolean;
	reads: boolean;
	writes: boolean;
	allocates: boolean;
	dictates: boolean;
	no_rollback: boolean;
}

export const EFFECT_NAMES = [
	'suspends', 'decides', 'diverges', 'reads', 'writes', 'allocates',
	'dictates', 'no_rollback',
] as const;

export function makeEffects(partial: Partial<EffectSet> = {}): EffectSet {
	return {
		suspends: false,
		decides: false,
		diverges: false,
		reads: false,
		writes: false,
		allocates: false,
		dictates: false,
		no_rollback: false,
		...partial,
	};
}

/** The default effect set for a function with no effect specifiers:
 * transacts (reads+writes+allocates) + diverges + dictates. */
export function defaultEffects(): EffectSet {
	return makeEffects({
		reads: true, writes: true, allocates: true, diverges: true, dictates: true,
	});
}

export interface EffectResolution {
	effects: EffectSet;
	errors: string[];
}

/**
 * Resolves declared effect specifiers to an effect set. Families:
 *   Heap:       transacts (default) | computes | varies | reads/writes/allocates
 *   Suspension: suspends
 *   Decision:   decides
 *   Divergence: diverges (default) | converges
 *   Prediction: dictates (default) | predicts
 */
export function resolveEffectSpecifiers(specifiers: Specifier[]): EffectResolution {
	const errors: string[] = [];
	type HeapMode = 'default' | 'transacts' | 'computes' | 'varies' | 'explicit';
	let heap: HeapMode = 'default' as HeapMode;
	let explicitReads = false;
	let explicitWrites = false;
	let explicitAllocates = false;
	let suspends = false;
	let decides = false;
	let converges = false;
	let predicts = false;
	let noRollback = false;

	const setHeap = (mode: HeapMode, name: string) => {
		if (heap !== 'default' && heap !== mode) {
			errors.push(`Conflicting heap effect specifiers ('${name}')`);
		}
		heap = mode;
	};

	for (const spec of specifiers) {
		switch (spec.name) {
			case 'transacts': setHeap('transacts', spec.name); break;
			case 'computes': setHeap('computes', spec.name); break;
			case 'varies': setHeap('varies', spec.name); break;
			case 'reads': explicitReads = true; setHeap('explicit', spec.name); break;
			case 'writes': explicitWrites = true; setHeap('explicit', spec.name); break;
			case 'allocates': explicitAllocates = true; setHeap('explicit', spec.name); break;
			case 'suspends': suspends = true; break;
			case 'decides': decides = true; break;
			case 'converges': converges = true; break;
			case 'diverges': converges = false; break;
			case 'predicts': predicts = true; break;
			case 'dictates': predicts = false; break;
			case 'no_rollback': noRollback = true; break;
			default:
				errors.push(`Unknown effect specifier '<${spec.name}>'`);
		}
	}

	if (suspends && decides) {
		errors.push("A function cannot be both '<suspends>' and '<decides>'");
	}

	let reads: boolean;
	let writes: boolean;
	let allocates: boolean;
	let diverges = !converges;
	switch (heap) {
		case 'computes':
			reads = false; writes = false; allocates = false;
			// <computes> implies convergence: it's a pure computation.
			diverges = false;
			break;
		case 'explicit':
			reads = explicitReads; writes = explicitWrites; allocates = explicitAllocates;
			break;
		case 'varies':
		case 'transacts':
		case 'default':
			reads = true; writes = true; allocates = true;
			break;
	}

	return {
		effects: makeEffects({
			suspends, decides, diverges, reads, writes, allocates,
			dictates: !predicts,
			no_rollback: noRollback,
		}),
		errors,
	};
}

/** True when `callee` effects fit within the `caller` budget. Returns the
 * first offending effect name, or null when the call is legal. */
export function effectViolation(caller: EffectSet, callee: EffectSet): string | null {
	for (const name of EFFECT_NAMES) {
		if (name === 'decides' || name === 'no_rollback') {
			// `decides` legality is a failure-context question, not a budget
			// question; no_rollback is a legacy marker.
			continue;
		}
		if (callee[name] && !caller[name]) {
			return name;
		}
	}
	return null;
}

export function effectsToString(effects: EffectSet): string {
	const names = EFFECT_NAMES.filter((n) => effects[n]);
	return names.length > 0 ? `<${names.join('><')}>` : '<computes><converges>';
}

export function unionEffects(a: EffectSet, b: EffectSet): EffectSet {
	const result = makeEffects();
	for (const name of EFFECT_NAMES) {
		result[name] = a[name] || b[name];
	}
	return result;
}
