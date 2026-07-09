// adapters.test.ts
// Storage adapters: memory + JSON-file roundtrips, and end-to-end weak_map
// persistence through a host across separate runs.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost } from '../../src/verse';
import { MemoryStorageAdapter } from '../../src/verse/adapters';
import { JsonFileStorageAdapter } from '../../src/verse/adapters/node';
import { uefnModules } from '../../src/verse/extras/uefn';

describe('MemoryStorageAdapter', () => {
	it('roundtrips values and returns null for missing keys', () => {
		const adapter = new MemoryStorageAdapter();
		expect(adapter.load('missing')).toBeNull();
		adapter.store('a', '{"x":1}');
		expect(adapter.load('a')).toBe('{"x":1}');
		adapter.clear();
		expect(adapter.load('a')).toBeNull();
	});
});

describe('JsonFileStorageAdapter', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'verse-adapters-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('roundtrips values through the file', () => {
		const file = join(dir, 'store.json');
		const adapter = new JsonFileStorageAdapter(file);
		expect(adapter.load('missing')).toBeNull();
		adapter.store('scores', '[[1,2]]');
		adapter.store('names', '["a"]');

		// A fresh adapter instance reads back from disk.
		const reopened = new JsonFileStorageAdapter(file);
		expect(reopened.load('scores')).toBe('[[1,2]]');
		expect(reopened.load('names')).toBe('["a"]');

		// The file itself is one JSON object keyed by storage key.
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		expect(Object.keys(raw).sort()).toEqual(['names', 'scores']);
	});

	it('starts empty on a corrupt file', () => {
		const file = join(dir, 'store.json');
		const adapter = new JsonFileStorageAdapter(file);
		adapter.store('k', 'v');
		const corrupted = new JsonFileStorageAdapter(file);
		// Overwrite with garbage before first read.
		writeFileSync(file, 'not json');
		expect(corrupted.load('k')).toBeNull();
	});

	it('creates missing parent directories on store', () => {
		const file = join(dir, 'nested', 'deep', 'store.json');
		const adapter = new JsonFileStorageAdapter(file);
		adapter.store('k', '"v"');
		expect(new JsonFileStorageAdapter(file).load('k')).toBe('"v"');
	});
});

const PERSISTENT_SOURCE = `
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

describe('persistence through a host', () => {
	it('persists across runs with a host-default memory adapter', async () => {
		const host = createHost({
			modules: uefnModules,
			persistence: new MemoryStorageAdapter(),
		});
		expect((await host.execute(PERSISTENT_SOURCE)).output).toEqual(['score was 0']);
		expect((await host.execute(PERSISTENT_SOURCE)).output).toEqual(['score was 10']);
		expect((await host.execute(PERSISTENT_SOURCE)).output).toEqual(['score was 20']);
	});

	it('persists across separate hosts through a JSON file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'verse-persist-'));
		try {
			const file = join(dir, 'save.json');

			const first = createHost({
				modules: uefnModules,
				persistence: new JsonFileStorageAdapter(file),
			});
			expect((await first.execute(PERSISTENT_SOURCE)).output).toEqual(['score was 0']);

			// A brand-new host + adapter (fresh process, conceptually) sees
			// the data on disk.
			const second = createHost({
				modules: uefnModules,
				persistence: new JsonFileStorageAdapter(file),
			});
			expect((await second.execute(PERSISTENT_SOURCE)).output).toEqual(['score was 10']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('per-run persistence overrides the host default', async () => {
		const host = createHost({
			modules: uefnModules,
			persistence: new MemoryStorageAdapter(),
		});
		const override = new MemoryStorageAdapter();
		const outcome = host.compile(PERSISTENT_SOURCE, { strict: true });
		if (!outcome.ok) {
			throw new Error('compile failed');
		}
		const run = host.run(outcome, { persistence: override });
		await run.done;
		expect(override.entries().length).toBeGreaterThan(0);
	});
});
