// Runs every example through the full pipeline: node scripts/run-examples.mjs
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileVerse } from '../src/verse/compile.js';
import { VerseInterpreter } from '../src/verse/interpreter.js';
import { DebugController } from '../src/verse/debug/DebugController.js';

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');
const files = (await readdir(examplesDir)).filter(f => f.endsWith('.verse'));
let failed = false;

for (const file of files) {
	const source = await readFile(join(examplesDir, file), 'utf8');
	console.log(`\n=== ${file} ===`);
	const result = compileVerse(source);
	if (!result.ok) {
		console.error('COMPILE FAILED:', result.diagnostic);
		failed = true;
		continue;
	}
	const controller = new DebugController({ lineMap: result.lineMap });
	const interpreter = new VerseInterpreter({
		onOutput: line => console.log('  ', line),
		controller,
	});
	try {
		await interpreter.interpret(result.ast);
	} catch (error) {
		console.error('RUNTIME FAILED:', error.message);
		failed = true;
	}
}

process.exit(failed ? 1 : 0);
