// verse-intellisense.js
// Monaco language providers for Verse, backed by the IDE host's semantic
// checker (src/verse/analysis.ts): hover shows checked types/signatures,
// go-to-definition jumps to declarations, and completions are scope-aware
// (locals, params, class members, natives). Falls back to the static
// builtin docs index when the source doesn't currently parse.

import { symbolDocToMarkdown } from '@/src/verse';
import { completionsAt, definitionAt, hoverAt } from '@/src/verse/analysis';
import { ideHost } from '@/src/ide/verse-host';

const VERSE_LANGUAGE_ID = 'verse';

// Per-model analysis cache: recompile only when the buffer changes.
// Keeps the last analysis that parsed so completions keep working while
// the user is mid-edit with a syntax error.
const analysisCache = new Map();

function getAnalysis(model) {
	const key = model.uri.toString();
	const versionId = model.getVersionId();
	const cached = analysisCache.get(key);
	if (cached && cached.versionId === versionId) {
		return cached;
	}
	let analysis;
	try {
		analysis = ideHost.analyze(model.getValue());
	} catch {
		analysis = { ok: false, program: null, moduleScope: null, diagnostics: [] };
	}
	const entry = {
		versionId,
		analysis,
		lastGood: analysis.ok ? analysis : cached?.lastGood ?? null,
	};
	analysisCache.set(key, entry);
	return entry;
}

function spanToRange(monaco, span) {
	return new monaco.Range(span.start.line, span.start.col, span.end.line, span.end.col);
}

function completionKindFor(monaco, kind) {
	const kinds = monaco.languages.CompletionItemKind;
	switch (kind) {
		case 'local': return kinds.Variable;
		case 'global': return kinds.Constant;
		case 'function': return kinds.Function;
		case 'native': return kinds.Function;
		case 'member': return kinds.Field;
		case 'class': return kinds.Class;
		case 'enum': return kinds.Enum;
		case 'module': return kinds.Module;
		case 'typeParam': return kinds.TypeParameter;
		case 'typeAlias': return kinds.Interface;
		default: return kinds.Text;
	}
}

export function registerVerseIntellisense(monaco) {
	const symbolIndex = ideHost.symbolIndex();
	const modulePaths = ideHost.modulePaths();

	monaco.languages.registerHoverProvider(VERSE_LANGUAGE_ID, {
		provideHover(model, position) {
			const word = model.getWordAtPosition(position);
			if (!word) {
				return null;
			}

			// Checker-backed hover: types, signatures, members, locals.
			const { analysis, lastGood } = getAnalysis(model);
			const active = analysis.ok ? analysis : lastGood;
			if (active) {
				const hover = hoverAt(active, position.lineNumber, position.column);
				if (hover) {
					return {
						range: new monaco.Range(
							position.lineNumber,
							word.startColumn,
							position.lineNumber,
							word.endColumn,
						),
						contents: [{ value: hover.markdown }],
					};
				}
			}

			// Fallback: static builtin docs by name.
			const symbol = symbolIndex.get(word.word);
			if (!symbol) {
				return null;
			}
			return {
				range: new monaco.Range(
					position.lineNumber,
					word.startColumn,
					position.lineNumber,
					word.endColumn,
				),
				contents: [{ value: symbolDocToMarkdown(symbol) }],
			};
		},
	});

	monaco.languages.registerDefinitionProvider(VERSE_LANGUAGE_ID, {
		provideDefinition(model, position) {
			const { analysis, lastGood } = getAnalysis(model);
			const active = analysis.ok ? analysis : lastGood;
			if (!active) {
				return null;
			}
			const span = definitionAt(active, position.lineNumber, position.column);
			if (!span) {
				return null;
			}
			return {
				uri: model.uri,
				range: spanToRange(monaco, span),
			};
		},
	});

	monaco.languages.registerCompletionItemProvider(VERSE_LANGUAGE_ID, {
		triggerCharacters: ['/'],
		provideCompletionItems(model, position) {
			const word = model.getWordUntilPosition(position);
			const range = new monaco.Range(
				position.lineNumber,
				word.startColumn,
				position.lineNumber,
				word.endColumn,
			);
			const linePrefix = model.getValueInRange(
				new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column),
			);

			// Inside `using { ... }`, offer module paths instead of symbols.
			if (/^\s*using\s*\{[^}]*$/.test(linePrefix)) {
				const pathStart = linePrefix.lastIndexOf('/');
				const pathRange = pathStart >= 0
					? new monaco.Range(
						position.lineNumber,
						pathStart + 1,
						position.lineNumber,
						position.column,
					)
					: range;
				return {
					suggestions: modulePaths.map((path) => ({
						label: path,
						kind: monaco.languages.CompletionItemKind.Module,
						insertText: path,
						range: pathRange,
						detail: 'Verse module',
					})),
				};
			}

			const suggestions = [];
			const seen = new Set();

			// Scope-aware completions from the checker: everything visible
			// at the cursor (locals, params, members, globals, natives).
			const { analysis, lastGood } = getAnalysis(model);
			const active = analysis.ok ? analysis : lastGood;
			if (active) {
				const entries = completionsAt(active, position.lineNumber, position.column);
				for (const entry of entries) {
					seen.add(entry.name);
					suggestions.push({
						label: entry.name,
						kind: completionKindFor(monaco, entry.kind),
						insertText: entry.name,
						range,
						detail: entry.detail,
						documentation: entry.doc ? { value: entry.doc } : undefined,
					});
				}
			}

			// Builtins not already in scope (e.g. from modules that aren't
			// imported yet) still show up from the static index.
			for (const symbol of symbolIndex.values()) {
				if (seen.has(symbol.name)) {
					continue;
				}
				suggestions.push({
					label: symbol.name,
					kind: symbol.kind === 'class'
						? monaco.languages.CompletionItemKind.Class
						: monaco.languages.CompletionItemKind.Function,
					insertText: symbol.name,
					range,
					detail: symbol.signature,
					documentation: { value: symbolDocToMarkdown(symbol) },
				});
			}
			return { suggestions };
		},
	});
}
