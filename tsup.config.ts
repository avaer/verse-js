// tsup.config.ts
// Library build for the embeddable verse-js runtime (the Next.js IDE app
// imports the sources directly and does not use this build).

import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		'index': 'src/verse/index.ts',
		'analysis': 'src/verse/analysis.ts',
		'extras/uefn': 'src/verse/extras/uefn.ts',
		'adapters/index': 'src/verse/adapters/index.ts',
		'adapters/node': 'src/verse/adapters/node.ts',
	},
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	outDir: 'dist',
	tsconfig: 'tsconfig.lib.json',
	target: 'es2020',
	platform: 'neutral',
});
