// Runs every example through the full pipeline: node scripts/run-examples.mjs
// (Requires tsx for the TypeScript compiler sources: npx tsx scripts/run-examples.mjs)
//
// The examples directory is compiled as one workspace (shared module
// scope, like the IDE), then each file runs as the entry point with the
// rest acting as libraries — this is how multi-file-demo.verse reaches
// math-lib.verse.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../src/verse/index.ts';
import { uefnModules } from '../src/verse/extras/uefn.ts';
import { NodeSourceFs } from '../src/verse/adapters/node.ts';

const host = createHost({ modules: uefnModules });
const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const fs = new NodeSourceFs(examplesDir);
let failed = false;

for (const file of fs.listFiles()) {
	console.log(`\n=== ${file} ===`);
	const { output, errors } = await host.executeWorkspace(fs, { entry: file });
	for (const line of output) {
		console.log('  ', line);
	}
	if (errors.length > 0) {
		console.error('FAILED:', errors.join('\n'));
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
