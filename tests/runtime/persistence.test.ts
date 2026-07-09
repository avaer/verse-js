// persistence.test.ts
// Phase 5: module-scoped weak_map vars backed by a persistence adapter
// (localStorage in the IDE), JSON round-tripping, and <persistable>
// validation diagnostics.

import { describe, expect, it } from 'vitest';
import { testHost } from '../helpers/test-host';

function makeAdapter(store: Map<string, string>) {
	return {
		load: (key: string) => store.get(key) ?? null,
		store: (key: string, json: string) => {
			store.set(key, json);
		},
	};
}

describe('weak_map persistence', () => {
	it('persists entries across runs', async () => {
		const store = new Map<string, string>();
		const source = `
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
var PlayerScores : weak_map(player, int) = map{}

my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        ThePlayer := GetLocalPlayer()
        var Score : int = 0
        if (Existing := PlayerScores[ThePlayer]):
            set Score = Existing
        Print("score was {Score}")
        if (set PlayerScores[ThePlayer] = Score + 10) {}
`;
		const first = await testHost.execute(source, { persistence: makeAdapter(store) });
		expect(first.errors).toEqual([]);
		expect(first.output).toEqual(['score was 0']);

		const second = await testHost.execute(source, { persistence: makeAdapter(store) });
		expect(second.errors).toEqual([]);
		expect(second.output).toEqual(['score was 10']);
	});

	it('persists composite values (arrays and strings)', async () => {
		const store = new Map<string, string>();
		const source = `
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
var Inventories : weak_map(player, []string) = map{}

my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        P := GetLocalPlayer()
        var Items : []string = array{}
        if (Existing := Inventories[P]):
            set Items = Existing
        Print("items: {Items.Length}")
        if (set Inventories[P] = Items + array{"sword"}) {}
`;
		await testHost.execute(source, { persistence: makeAdapter(store) });
		await testHost.execute(source, { persistence: makeAdapter(store) });
		const third = await testHost.execute(source, { persistence: makeAdapter(store) });
		expect(third.output).toEqual(['items: 2']);
	});

	it('batches rapid writes: far fewer stores than writes, final state persisted', async () => {
		const store = new Map<string, string>();
		let storeCalls = 0;
		const adapter = {
			load: (key: string) => store.get(key) ?? null,
			store: (key: string, json: string) => {
				storeCalls += 1;
				store.set(key, json);
			},
		};
		const source = `
using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
var Counters : weak_map(player, int) = map{}

my_device := class(creative_device):
    OnBegin<override>()<suspends> : void =
        P := GetLocalPlayer()
        for (I := 1..1000):
            if (set Counters[P] = I) {}
        if (Final := Counters[P]):
            Print("final {Final}")
`;
		const result = await testHost.execute(source, { persistence: adapter });
		expect(result.errors).toEqual([]);
		expect(result.output).toEqual(['final 1000']);
		// 1000 writes used to mean 1000 full-map serializations; batching
		// collapses each sync section into one store (plus the end-of-run
		// flush).
		expect(storeCalls).toBeLessThan(10);
		// The last write is what actually landed in storage.
		const stored = [...store.values()];
		expect(stored.length).toBe(1);
		expect(stored[0]).toContain('1000');
	});
});

describe('persistable validation', () => {
	it('rejects var fields in persistable classes', () => {
		const result = testHost.compile(`
save_data := class<final><persistable>:
    var Coins : int = 0
`);
		expect(result.diagnostics.some((d) =>
			d.severity === 'error' && /persistable/i.test(d.message))).toBe(true);
	});

	it('requires final on persistable classes', () => {
		const result = testHost.compile(`
save_data := class<persistable>:
    Coins : int = 0
`);
		expect(result.diagnostics.some((d) =>
			d.severity === 'error' && /persistable.*final/i.test(d.message))).toBe(true);
	});

	it('accepts a valid persistable class', () => {
		const result = testHost.compile(`
save_data := class<final><persistable>:
    Coins : int = 0
    Name : string = ""
`);
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
	});
});
