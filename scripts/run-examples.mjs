// Runs every example through the full pipeline: node scripts/run-examples.mjs
// (Requires tsx for the TypeScript compiler sources: npx tsx scripts/run-examples.mjs)
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/verse/index.ts';
import { uefnModules } from '../src/verse/extras/uefn.ts';

const host = createHost({ modules: uefnModules });
const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const files = (await readdir(examplesDir)).filter(f => f.endsWith('.verse'));
let failed = false;

for (const file of files) {
	const source = await readFile(join(examplesDir, file), 'utf8');
	console.log(`\n=== ${file} ===`);
	const { output, errors } = await host.execute(source);
	for (const line of output) {
		console.log('  ', line);
	}
	if (errors.length > 0) {
		console.error('FAILED:', errors.join('\n'));
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
