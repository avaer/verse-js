// vmap.test.ts
// Dedicated coverage for the two-tier VMap: primitive keys are used as raw
// JS Map keys, structural keys are interned via canonicalKey. Also covers
// the transaction journal's map entries and Verse-level map rollback.

import { describe, expect, it } from 'vitest';
import { createHost } from '../../src/verse/index';
import { FAIL, VMap, VOption, VRational, VTuple } from '../../src/verse/runtime/values';
import { Transaction } from '../../src/verse/runtime/failure';

describe('VMap two-tier keys', () => {
	it('stores and retrieves primitive keys', () => {
		const m = new VMap();
		m.set(5, 'five');
		m.set('name', 'str');
		m.set(true, 'yes');
		m.set(2.5, 'half');
		expect(m.get(5)).toBe('five');
		expect(m.get('name')).toBe('str');
		expect(m.get(true)).toBe('yes');
		expect(m.get(2.5)).toBe('half');
		expect(m.get(6)).toBe(FAIL);
		expect(m.size).toBe(4);
	});

	it('void is a valid key distinct from every miss', () => {
		const m = new VMap();
		expect(m.get(undefined)).toBe(FAIL);
		m.set(undefined, 'unit');
		expect(m.get(undefined)).toBe('unit');
		expect(m.has(undefined)).toBe(true);
		expect(m.delete(undefined)).toBe(true);
		expect(m.get(undefined)).toBe(FAIL);
	});

	it('structural keys compare by value, not identity', () => {
		const m = new VMap();
		m.set([1, 2], 'arr');
		m.set(new VTuple([1, 'x']), 'tup');
		m.set(VOption.someAllowingUndefined(3), 'opt');
		expect(m.get([1, 2])).toBe('arr');
		expect(m.get(new VTuple([1, 'x']))).toBe('tup');
		expect(m.get(VOption.someAllowingUndefined(3))).toBe('opt');
		expect(m.get([1, 3])).toBe(FAIL);
		expect(m.size).toBe(3);
	});

	it('a raw string key never collides with a structural key encoding', () => {
		const m = new VMap();
		m.set([1], 'array');
		// canonicalKey([1]) is 'a[i1]'; the raw string must stay separate.
		m.set('a[i1]', 'string');
		expect(m.get([1])).toBe('array');
		expect(m.get('a[i1]')).toBe('string');
		expect(m.size).toBe(2);
	});

	it('integral rationals unify with int keys', () => {
		const m = new VMap();
		m.set(4, 'int');
		expect(m.get(new VRational(4, 1))).toBe('int');
		m.set(new VRational(8, 2), 'reduced');
		expect(m.get(4)).toBe('reduced');
		expect(m.size).toBe(1);
		m.set(new VRational(1, 2), 'half');
		expect(m.get(new VRational(1, 2))).toBe('half');
		expect(m.get(0.5)).toBe(FAIL); // float 0.5 is not rational 1/2
	});

	it('overwrites keep a single entry and pairs stay insertion-ordered', () => {
		const m = new VMap();
		m.set('a', 1);
		m.set([9], 2);
		m.set('a', 3);
		expect([...m.pairs()]).toEqual([['a', 3], [[9], 2]]);
	});

	it('clone is independent for both key tiers', () => {
		const m = new VMap();
		m.set(1, 'one');
		m.set([2], 'two');
		const c = m.clone();
		c.set(1, 'uno');
		c.set([2], 'dos');
		c.set([3], 'tres');
		expect(m.get(1)).toBe('one');
		expect(m.get([2])).toBe('two');
		expect(m.get([3])).toBe(FAIL);
		expect(c.get(1)).toBe('uno');
		expect(c.get([2])).toBe('dos');
		expect(c.get([3])).toBe('tres');
	});
});

describe('VMap journal integration', () => {
	it('rollback restores overwritten and inserted entries (both tiers)', () => {
		const m = new VMap();
		m.set('kept', 1);
		m.set([7], 'orig');
		const txn = new Transaction();
		txn.recordMapEntry(m, 'kept');
		m.set('kept', 99);
		txn.recordMapEntry(m, [7]);
		m.set([7], 'changed');
		txn.recordMapEntry(m, 'new');
		m.set('new', 5);
		txn.rollback();
		expect(m.get('kept')).toBe(1);
		expect(m.get([7])).toBe('orig');
		expect(m.has('new')).toBe(false);
		expect(m.size).toBe(2);
	});

	it('commit hands entries to the parent so an outer rollback still undoes', () => {
		const m = new VMap();
		const outer = new Transaction();
		const inner = new Transaction(outer);
		inner.recordMapEntry(m, 'x');
		m.set('x', 1);
		inner.commit();
		outer.rollback();
		expect(m.has('x')).toBe(false);
	});
});

describe('Verse-level map behavior', () => {
	const host = createHost();

	it('map writes in a failing condition roll back', async () => {
		const r = await host.execute(`
var M : [string]int = map{"a" => 1}
if (set M["a"] = 100, set M["b"] = 2, false?):
    Print("wrong")
if (A := M["a"]):
    Print("a = {A}")
if (not M["b"]):
    Print("no b")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['a = 1', 'no b']);
	});

	it('tuple keys work through Verse code', async () => {
		const r = await host.execute(`
var Board : [tuple(int, int)]string = map{}
if (set Board[(1, 2)] = "knight") {}
if (V := Board[(1, 2)]):
    Print(V)
if (not Board[(2, 1)]):
    Print("empty")
`);
		expect(r.errors).toEqual([]);
		expect(r.output).toEqual(['knight', 'empty']);
	});
});
