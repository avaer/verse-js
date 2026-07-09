// docs.js
// Generates the builtin/core-library documentation from the module registry
// in libraries.js. Single source of truth: whatever is registered there shows
// up automatically in the IDE Docs panel, editor hovers, and completions.

import { VERSE_LIBRARY_REGISTRY, IMPLICITLY_IMPORTED_PATHS } from './libraries.js';

// `Print` is a grammar-level statement in this interpreter rather than a
// registry function, but users expect to find it in the docs.
const SYNTHETIC_SYMBOLS = {
	'/UnrealEngine.com/Temporary/Diagnostics': [
		{
			name: 'Print',
			kind: 'function',
			signature: 'Print(Message: string): void',
			effects: [],
			doc: 'Writes Message to the console. Accepts string literals and interpolated strings; interpolate any int, float, or string with curly braces: "{Expression}". Implemented as a built-in statement in verse-js, so it works without any using declaration.',
			example: 'Print("Score: {Points + Bonus}")',
			overloadSignatures: [],
		},
	],
};

export function formatSignature(metadata) {
	const parameterList = (metadata.parameters || [])
		.map((parameterType, index) => {
			const parameterName = metadata.paramNames?.[index] || `Arg${index + 1}`;
			return `${parameterName}: ${parameterType}`;
		})
		.join(', ');
	const effectList = (metadata.effects || []).map(effect => `<${effect}>`).join('');
	return `${metadata.name}(${parameterList})${effectList}: ${metadata.returnType}`;
}

function formatOverloadSignature(name, overload) {
	const parameterList = overload.parameterTypes.map(type => `:${type}`).join(', ');
	const effectList = (overload.effects || []).map(effect => `<${effect}>`).join('');
	return `${name}(${parameterList})${effectList}: ${overload.returnType}`;
}

function toSymbolDoc(symbolName, exportedSymbol) {
	const metadata = exportedSymbol.metadata || exportedSymbol;

	if (metadata.type === 'NativeClass') {
		return {
			name: symbolName,
			kind: 'class',
			signature: `${symbolName} := class`,
			effects: [],
			doc: metadata.doc || '',
			example: metadata.example || '',
			overloadSignatures: [],
		};
	}

	return {
		name: symbolName,
		kind: 'function',
		signature: formatSignature(metadata),
		effects: metadata.effects || [],
		doc: metadata.doc || '',
		example: metadata.example || '',
		overloadSignatures: (metadata.overloads || []).map(overload =>
			formatOverloadSignature(symbolName, overload),
		),
	};
}

// Returns [{ path, description, implicit, symbols: [symbolDoc] }] sorted with
// the prelude first, then alphabetically.
export function generateBuiltinDocs() {
	const modules = Object.entries(VERSE_LIBRARY_REGISTRY).map(([path, library]) => {
		const symbols = Object.entries(library.exports).map(([symbolName, exportedSymbol]) =>
			toSymbolDoc(symbolName, exportedSymbol),
		);

		for (const synthetic of SYNTHETIC_SYMBOLS[path] || []) {
			symbols.push(synthetic);
		}

		symbols.sort((a, b) => a.name.localeCompare(b.name));

		return {
			path,
			description: library.description || '',
			implicit: IMPLICITLY_IMPORTED_PATHS.includes(path),
			symbols,
		};
	});

	modules.sort((a, b) => {
		if (a.implicit !== b.implicit) {
			return a.implicit ? -1 : 1;
		}
		return a.path.localeCompare(b.path);
	});

	return modules;
}

// name -> { ...symbolDoc, modulePath, implicit } for hover/completion lookup.
export function buildSymbolIndex() {
	const index = new Map();
	for (const moduleDoc of generateBuiltinDocs()) {
		for (const symbol of moduleDoc.symbols) {
			index.set(symbol.name, {
				...symbol,
				modulePath: moduleDoc.path,
				implicit: moduleDoc.implicit,
			});
		}
	}
	return index;
}

export function getModulePaths() {
	return Object.keys(VERSE_LIBRARY_REGISTRY).sort();
}

// Markdown rendering shared by Monaco hovers and completion documentation.
export function symbolDocToMarkdown(symbol) {
	const lines = [];
	lines.push('```verse\n' + symbol.signature + '\n```');
	if (symbol.doc) {
		lines.push(symbol.doc);
	}
	if (symbol.overloadSignatures.length > 0) {
		lines.push('**Overloads**\n' + symbol.overloadSignatures.map(s => `- \`${s}\``).join('\n'));
	}
	if (symbol.example) {
		lines.push('```verse\n' + symbol.example + '\n```');
	}
	lines.push(
		symbol.implicit
			? `_${symbol.modulePath} (implicitly imported)_`
			: `_requires \`using { ${symbol.modulePath} }\`_`,
	);
	return lines.join('\n\n');
}
