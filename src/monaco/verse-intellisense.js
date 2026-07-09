// verse-intellisense.js
// Monaco language providers for Verse, backed by the IDE host's semantic
// checker (src/verse/analysis.ts): hover shows checked types/signatures,
// go-to-definition jumps to declarations, and completions are scope-aware
// (locals, params, class members, natives). Falls back to the static
// builtin docs index when the source doesn't currently parse.

import { symbolDocToMarkdown } from '@/src/verse';
import { completionsAt, definitionAt, hoverAt } from '@/src/verse/analysis';
import { ideHost, ideWorkspace } from '@/src/ide/verse-host';

const VERSE_LANGUAGE_ID = 'verse';

// Workspace analysis cache: the whole workspace is re-analyzed only when
// any file changes (ideWorkspace.version bumps). Per-file lastGood keeps
// hover/completions working while the user is mid-edit with a syntax
// error somewhere in the workspace.
let workspaceCache = { version: -1, analysis: null };
const lastGoodByFile = new Map();

/** Workspace file name for a Monaco model (models are named by path). */
function fileNameOf(model) {
	return model.uri.path.replace(/^\//, '');
}

function getWorkspaceAnalysis() {
	if (workspaceCache.version === ideWorkspace.version && workspaceCache.analysis) {
		return workspaceCache.analysis;
	}
	let analysis;
	try {
		analysis = ideHost.analyzeWorkspace(ideWorkspace.fs);
	} catch {
		analysis = { ok: false, files: new Map(), diagnostics: [] };
	}
	workspaceCache = { version: ideWorkspace.version, analysis };
	if (analysis.ok) {
		for (const [file, fileAnalysis] of analysis.files) {
			lastGoodByFile.set(file, fileAnalysis);
		}
	}
	return analysis;
}

/** The current (or last good) analysis for one model's file. */
function getAnalysisFor(model) {
	const file = fileNameOf(model);
	const workspace = getWorkspaceAnalysis();
	return workspace.files.get(file) ?? lastGoodByFile.get(file) ?? null;
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
			const active = getAnalysisFor(model);
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
			const active = getAnalysisFor(model);
			if (!active) {
				return null;
			}
			const location = definitionAt(active, position.lineNumber, position.column);
			if (!location) {
				return null;
			}
			if (location.file !== fileNameOf(model)) {
				// Cross-file definition: the IDE owns tabs/models, so hand
				// navigation to it instead of letting Monaco swap models.
				window.dispatchEvent(new CustomEvent('verse-open-location', {
					detail: { file: location.file, line: location.span.start.line },
				}));
				return null;
			}
			return {
				uri: model.uri,
				range: spanToRange(monaco, location.span),
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
			// at the cursor (locals, params, members, globals, natives) —
			// including definitions from other workspace files.
			const active = getAnalysisFor(model);
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
