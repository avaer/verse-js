// Aggregate self-time by function from a V8 .cpuprofile (dev tool, not shipped).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.profiles';
const files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort();
const file = join(dir, files[files.length - 1]);
const prof = JSON.parse(readFileSync(file, 'utf8'));

const nodesById = new Map();
for (const n of prof.nodes) nodesById.set(n.id, n);

// samples + timeDeltas -> self time per node
const selfMicros = new Map();
for (let i = 0; i < prof.samples.length; i++) {
	const id = prof.samples[i];
	const dt = prof.timeDeltas[i] ?? 0;
	selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt);
}

const byFn = new Map();
for (const [id, micros] of selfMicros) {
	const n = nodesById.get(id);
	if (!n) continue;
	const cf = n.callFrame;
	const url = (cf.url || '').replace(/^file:\/\/\/?/, '').split(/[\\/]/).slice(-2).join('/');
	const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber + 1}`;
	byFn.set(key, (byFn.get(key) ?? 0) + micros);
}

const total = [...byFn.values()].reduce((a, b) => a + b, 0);
const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45);
console.log(`profile: ${file}, total ${(total / 1000).toFixed(1)} ms\n`);
for (const [key, micros] of rows) {
	const ms = (micros / 1000).toFixed(1).padStart(8);
	const pct = ((micros / total) * 100).toFixed(1).padStart(5);
	console.log(`${ms} ms ${pct}%  ${key}`);
}
