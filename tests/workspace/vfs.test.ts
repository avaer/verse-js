// vfs.test.ts
// Source-filesystem contract tests, shared between MemorySourceFs and
// NodeSourceFs so both honor the same semantics.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MemorySourceFs, toSourceFs } from '../../src/verse/vfs';
import type { SourceFileSystem } from '../../src/verse/vfs';
import { NodeSourceFs } from '../../src/verse/adapters/node';

const SEED = {
	'main.verse': 'Print("main")',
	'lib.verse': 'Helper() : void = {}',
};

/** Contract every SourceFileSystem implementation must satisfy. */
function describeContract(name: string, make: () => SourceFileSystem): void {
	describe(`${name} (contract)`, () => {
		it('lists all .verse files', () => {
			const fs = make();
			expect([...fs.listFiles()].sort()).toEqual(['lib.verse', 'main.verse']);
		});

		it('reads file contents by path', () => {
			const fs = make();
			expect(fs.readFile('main.verse')).toBe('Print("main")');
			expect(fs.readFile('lib.verse')).toBe('Helper() : void = {}');
		});

		it('returns null for missing files', () => {
			const fs = make();
			expect(fs.readFile('nope.verse')).toBeNull();
		});
	});
}

describeContract('MemorySourceFs', () => new MemorySourceFs({ ...SEED }));

const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describeContract('NodeSourceFs', () => {
	const dir = mkdtempSync(join(tmpdir(), 'verse-vfs-'));
	tempDirs.push(dir);
	for (const [name, source] of Object.entries(SEED)) {
		writeFileSync(join(dir, name), source);
	}
	// Non-.verse files are invisible to the workspace.
	writeFileSync(join(dir, 'notes.txt'), 'ignore me');
	return new NodeSourceFs(dir);
});

describe('MemorySourceFs mutation', () => {
	it('writeFile and deleteFile update the listing', () => {
		const fs = new MemorySourceFs({ ...SEED });
		fs.writeFile('extra.verse', 'Print("x")');
		expect(fs.listFiles()).toContain('extra.verse');
		expect(fs.readFile('extra.verse')).toBe('Print("x")');
		fs.deleteFile('extra.verse');
		expect(fs.listFiles()).not.toContain('extra.verse');
		expect(fs.readFile('extra.verse')).toBeNull();
	});
});

describe('toSourceFs', () => {
	it('passes real filesystems through unchanged', () => {
		const fs = new MemorySourceFs({ ...SEED });
		expect(toSourceFs(fs)).toBe(fs);
	});

	it('wraps plain records', () => {
		const fs = toSourceFs({ 'a.verse': 'Print("a")' });
		expect(fs.listFiles()).toEqual(['a.verse']);
		expect(fs.readFile('a.verse')).toBe('Print("a")');
	});
});

describe('NodeSourceFs on a missing directory', () => {
	it('lists nothing and reads null', () => {
		const fs = new NodeSourceFs(join(tmpdir(), 'verse-vfs-definitely-missing'));
		expect(fs.listFiles()).toEqual([]);
		expect(fs.readFile('x.verse')).toBeNull();
	});
});
