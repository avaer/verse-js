// docs.ts
// Generates browsable documentation from a bindings registry. Single
// source of truth: whatever modules are registered on a host show up
// automatically in docs panels, editor hovers, and completions.

import { NativeEntry, NativeModuleDef, NativeRegistry } from './bindings/registry';
import { EffectSet } from './sema/effects';
import { typeToString, FuncT } from './sema/types';

/** Documentation for a single exported symbol of a native module. */
export interface SymbolDoc {
	name: string;
	kind: 'function' | 'class' | 'value' | 'enum';
	signature: string;
	effects: string[];
	doc: string;
	example: string;
	overloadSignatures: string[];
}

/** Documentation for one native module. */
export interface ModuleDoc {
	path: string;
	description: string;
	/** True when the module is imported implicitly (no `using` needed). */
	implicit: boolean;
	symbols: SymbolDoc[];
}

/** name -> symbol doc plus origin info, for hover/completion indexes. */
export type IndexedSymbolDoc = SymbolDoc & { modulePath: string; implicit: boolean };

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
			signature: `${entry.name} := enum{${entry.info.values.join(', ')}}`,
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
		implicit: def.implicit,
		symbols,
	};
}

/**
 * Generates docs for every module in a registry, sorted with implicit
 * modules (the prelude) first, then alphabetically by path.
 */
export function generateDocs(registry: NativeRegistry): ModuleDoc[] {
	const modules = [...registry.modules.values()].map(toModuleDoc);
	modules.sort((a, b) => {
		if (a.implicit !== b.implicit) {
			return a.implicit ? -1 : 1;
		}
		return a.path.localeCompare(b.path);
	});
	return modules;
}

/** Flattens module docs into a name -> symbol index (first module wins). */
export function buildSymbolIndex(docs: ModuleDoc[]): Map<string, IndexedSymbolDoc> {
	const index = new Map<string, IndexedSymbolDoc>();
	for (const moduleDoc of docs) {
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

/** Sorted module paths, e.g. for `using { ... }` completions. */
export function getModulePaths(docs: ModuleDoc[]): string[] {
	return docs.map((m) => m.path).sort();
}

/** Markdown rendering shared by editor hovers and completion docs. */
export function symbolDocToMarkdown(symbol: IndexedSymbolDoc): string {
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
