// verse-intellisense.js
// Hover and completion providers for Verse builtins, generated from the
// native module registry (src/verse/runtime/docs.js). Hovering a builtin
// shows its signature/docs; completions offer builtin symbols and, inside a
// `using` declaration, the available module paths.

import { buildSymbolIndex, getModulePaths, symbolDocToMarkdown } from '@/src/verse/runtime/docs';

const VERSE_LANGUAGE_ID = 'verse';

export function registerVerseIntellisense(monaco) {
	const symbolIndex = buildSymbolIndex();
	const modulePaths = getModulePaths();

	monaco.languages.registerHoverProvider(VERSE_LANGUAGE_ID, {
		provideHover(model, position) {
			const word = model.getWordAtPosition(position);
			if (!word) {
				return null;
			}
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
			for (const symbol of symbolIndex.values()) {
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
