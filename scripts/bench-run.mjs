// Bench runner: bundle scripts/bench.mts with esbuild (no keepNames shims,
// no on-the-fly transform) and run the result under plain node, so the
// numbers reflect the runtime rather than the dev loader. `tsx` injects a
// `__name` helper call into every compiled closure, which used to dominate
// the profile (~40% of total time).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'verse-bench-'));
const outFile = join(outDir, 'bench.mjs');

try {
	await build({
		entryPoints: [join(root, 'scripts', 'bench.mts')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2022',
		outfile: outFile,
		sourcemap: false,
		logLevel: 'silent',
	});
	const res = spawnSync(process.execPath, [...process.argv.slice(2), outFile], {
		stdio: 'inherit',
		cwd: root,
	});
	process.exitCode = res.status ?? 1;
} finally {
	rmSync(outDir, { recursive: true, force: true });
}
