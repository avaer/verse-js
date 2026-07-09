// docs.ts
// Generates the builtin/core-library documentation from the native module
// registry. Single source of truth: whatever is registered in
// natives/core.ts shows up automatically in the IDE Docs panel, editor
// hovers, and completions.

import { EffectSet } from '../sema/effects';
import { typeToString, FuncT } from '../sema/types';
import { buildNativeRegistry } from './natives/core';
import { NativeEntry, NativeModuleDef } from './natives/registry';

const IMPLICITLY_IMPORTED_PATHS = ['/Verse.org/Verse'];

export interface SymbolDoc {
	name: string;
	kind: 'function' | 'class' | 'value' | 'enum';
	signature: string;
	effects: string[];
	doc: string;
	example: string;
	overloadSignatures: string[];
}

export interface ModuleDoc {
	path: string;
	description: string;
	implicit: boolean;
	symbols: SymbolDoc[];
}

let cachedModules: ModuleDoc[] | null = null;

// Only suspends/decides are surfaced; reads/writes/allocates are the
// `transacts` default and would be noise on every entry.
function effectNames(effects: EffectSet): string[] {
	const names: string[] = [];
	if (effects.suspends) {
		names.push('suspends');
	}
	if (effects.decides) {
		names.push('decides');
	}
	return names;
}

function formatFuncSignature(name: string, sig: FuncT, paramNames: string[]): string {
	const params = sig.params
		.map((p, i) => `${p.named ? '?' : ''}${paramNames[i] ?? p.name ?? `Arg${i + 1}`}: ${typeToString(p.type)}`)
		.join(', ');
	const effects = effectNames(sig.effects).map((e) => `<${e}>`).join('');
	return `${name}(${params})${effects}: ${typeToString(sig.ret)}`;
}

function toSymbolDoc(entry: NativeEntry): SymbolDoc {
	if (entry.kind === 'function') {
		const [first, ...rest] = entry.signatures;
		return {
			name: entry.name,
			kind: 'function',
			signature: formatFuncSignature(entry.name, first, entry.paramNames[0] ?? []),
			effects: effectNames(first.effects),
			doc: entry.doc,
			example: entry.example ?? '',
			overloadSignatures: rest.map((sig, i) =>
				formatFuncSignature(entry.name, sig, entry.paramNames[i + 1] ?? [])),
		};
	}
	if (entry.kind === 'class') {
		return {
			name: entry.name,
			kind: 'class',
			signature: `${entry.name} := class`,
			effects: [],
			doc: entry.doc,
			example: entry.example ?? '',
			overloadSignatures: [],
		};
	}
	if (entry.kind === 'enum') {
		return {
			name: entry.name,
			kind: 'enum',
			signature: `${entry.name} := enum`,
			effects: [],
			doc: entry.doc,
			example: '',
			overloadSignatures: [],
		};
	}
	return {
		name: entry.name,
		kind: 'value',
		signature: `${entry.name}: ${typeToString(entry.type)}`,
		effects: [],
		doc: entry.doc,
		example: '',
		overloadSignatures: [],
	};
}

function toModuleDoc(def: NativeModuleDef): ModuleDoc {
	const symbols = [...def.entries.values()].map(toSymbolDoc);
	symbols.sort((a, b) => a.name.localeCompare(b.name));
	return {
		path: def.path,
		description: def.description,
		implicit: IMPLICITLY_IMPORTED_PATHS.includes(def.path),
		symbols,
	};
}

/**
 * Returns [{ path, description, implicit, symbols }] sorted with the
 * prelude first, then alphabetically.
 */
export function generateBuiltinDocs(): ModuleDoc[] {
	if (cachedModules) {
		return cachedModules;
	}
	const registry = buildNativeRegistry();
	const modules = [...registry.modules.values()].map(toModuleDoc);
	modules.sort((a, b) => {
		if (a.implicit !== b.implicit) {
			return a.implicit ? -1 : 1;
		}
		return a.path.localeCompare(b.path);
	});
	cachedModules = modules;
	return modules;
}

/** name -> { ...symbolDoc, modulePath, implicit } for hover/completions. */
export function buildSymbolIndex(): Map<string, SymbolDoc & { modulePath: string; implicit: boolean }> {
	const index = new Map<string, SymbolDoc & { modulePath: string; implicit: boolean }>();
	for (const moduleDoc of generateBuiltinDocs()) {
		for (const symbol of moduleDoc.symbols) {
			if (!index.has(symbol.name)) {
				index.set(symbol.name, {
					...symbol,
					modulePath: moduleDoc.path,
					implicit: moduleDoc.implicit,
				});
			}
		}
	}
	return index;
}

export function getModulePaths(): string[] {
	return generateBuiltinDocs().map((m) => m.path).sort();
}

/** Markdown rendering shared by Monaco hovers and completion docs. */
export function symbolDocToMarkdown(symbol: SymbolDoc & { modulePath: string; implicit: boolean }): string {
	const lines: string[] = [];
	lines.push('```verse\n' + symbol.signature + '\n```');
	if (symbol.doc) {
		lines.push(symbol.doc);
	}
	if (symbol.overloadSignatures.length > 0) {
		lines.push('**Overloads**\n' + symbol.overloadSignatures.map((s) => `- \`${s}\``).join('\n'));
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
