// The bundled example programs must parse with the new front end.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVerse } from '../../src/verse/frontend/parser';
import { printProgram } from '../../src/verse/frontend/printer';

const examplesDir = join(__dirname, '..', '..', 'examples');

describe('front end parses bundled examples', () => {
	for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.verse'))) {
		it(`parses ${file}`, () => {
			const source = readFileSync(join(examplesDir, file), 'utf8');
			const program = parseVerse(source);
			expect(program.body.length).toBeGreaterThan(0);
			// The printer must handle every node kind that appears.
			expect(printProgram(program).length).toBeGreaterThan(0);
		});
	}
});
