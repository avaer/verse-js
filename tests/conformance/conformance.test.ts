// conformance.test.ts
// Golden conformance corpus runner. Each .verse file under this directory
// is one test case, with expectations embedded as comment directives:
//
//   #>> text            expected stdout line (in order, exact match)
//   #!! <line>: substr  expected error diagnostic on <line> (substring)
//   #~~ <line>: substr  expected warning diagnostic on <line> (substring)
//   #@@ deviation: note documented deviation from real Verse (informational)
//
// Cases with #!! directives are compile-only: they assert diagnostics and
// are not executed. Everything else runs to completion under the virtual
// clock with a fixed RNG, and stdout is diffed exactly.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/verse';
import { testHost } from '../helpers/test-host';

const rootDir = join(fileURLToPath(import.meta.url), '..');

interface Expectation {
	stdout: string[];
	errors: { line: number; substring: string }[];
	warnings: { line: number; substring: string }[];
}

function parseDirectives(source: string): Expectation {
	const expectation: Expectation = { stdout: [], errors: [], warnings: [] };
	for (const rawLine of source.split('\n')) {
		const line = rawLine.trim();
		if (line.startsWith('#>>')) {
			// `#>>` with no text asserts an empty output line.
			expectation.stdout.push(line.slice(3).replace(/^ /, ''));
		} else if (line.startsWith('#!!') || line.startsWith('#~~')) {
			const m = /^#(?:!!|~~)\s*(\d+)\s*:\s*(.*)$/.exec(line);
			if (!m) {
				throw new Error(`Malformed diagnostic directive: ${line}`);
			}
			const entry = { line: Number(m[1]), substring: m[2] };
			(line.startsWith('#!!') ? expectation.errors : expectation.warnings).push(entry);
		}
	}
	return expectation;
}

function collectCases(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectCases(full));
		} else if (entry.name.endsWith('.verse')) {
			files.push(full);
		}
	}
	return files.sort();
}

async function execute(source: string): Promise<string[]> {
	const outcome = testHost.compile(source, { strict: true });
	if (!outcome.ok) {
		throw new Error(
			`compile failed:\n${outcome.diagnostics.map((d) => `${d.startLine}: ${d.message}`).join('\n')}`,
		);
	}
	const output: string[] = [];
	const clock = new VirtualClock();
	// Deterministic RNG: xorshift with a fixed seed.
	let seed = 0x9e3779b9;
	const rng = () => {
		seed ^= seed << 13; seed >>>= 0;
		seed ^= seed >> 17;
		seed ^= seed << 5; seed >>>= 0;
		return seed / 0x100000000;
	};
	const run = testHost.run(outcome, {
		clock,
		rng,
		onOutput: (level, text) => {
			if (level === 'stdout') {
				output.push(text);
			} else if (level === 'error') {
				output.push(`[error] ${text}`);
			}
		},
	});
	await clock.run(run.done);
	return output;
}

const cases = collectCases(rootDir);

describe('conformance corpus', () => {
	if (cases.length === 0) {
		it('has cases', () => {
			throw new Error('no .verse files found under tests/conformance');
		});
		return;
	}

	for (const file of cases) {
		const name = relative(rootDir, file).split(sep).join('/');
		const source = readFileSync(file, 'utf8');
		const expectation = parseDirectives(source);

		it(name, async () => {
			if (expectation.errors.length > 0) {
				// Diagnostics case: compile only (non-strict, like the IDE).
				const outcome = testHost.compile(source);
				const diags = outcome.diagnostics;
				for (const want of expectation.errors) {
					const hit = diags.find((d) =>
						d.severity === 'error' &&
						d.startLine === want.line &&
						d.message.includes(want.substring));
					expect(
						hit,
						`expected error on line ${want.line} containing ${JSON.stringify(want.substring)}; got:\n` +
						diags.map((d) => `  ${d.severity} ${d.startLine}: ${d.message}`).join('\n'),
					).toBeTruthy();
				}
				for (const want of expectation.warnings) {
					const hit = diags.find((d) =>
						d.severity === 'warning' &&
						d.startLine === want.line &&
						d.message.includes(want.substring));
					expect(
						hit,
						`expected warning on line ${want.line} containing ${JSON.stringify(want.substring)}`,
					).toBeTruthy();
				}
				return;
			}

			const output = await execute(source);
			expect(output).toEqual(expectation.stdout);

			if (expectation.warnings.length > 0) {
				const { diagnostics } = testHost.compile(source);
				for (const want of expectation.warnings) {
					const hit = diagnostics.find((d) =>
						d.severity === 'warning' &&
						d.startLine === want.line &&
						d.message.includes(want.substring));
					expect(
						hit,
						`expected warning on line ${want.line} containing ${JSON.stringify(want.substring)}`,
					).toBeTruthy();
				}
			}
		});
	}
});
