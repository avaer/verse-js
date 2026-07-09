// verse-language.js
// Registers the Verse language with Monaco: TextMate tokenization (via
// vscode-textmate + vscode-oniguruma), the verse-dark theme, and language
// configuration (comments, brackets, indentation).
// Vendorized from johanfortus/Verse-Online-Editor (MIT); the TextMate assets
// in ./tm originate from the official VS Code Verse extension grammar.

import { INITIAL, Registry, parseRawGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { registerVerseIntellisense } from './verse-intellisense.js';
import verseTheme from './tm/verse-dark.tmTheme.json';
import verseGrammar from './tm/verse.tmLanguage.json';
import languageConfiguration from './tm/language-configuration.json';

const VERSE_LANGUAGE_ID = 'verse';
const VERSE_SCOPE_NAME = 'source.verse';

// Served from public/onig.wasm (copied from vscode-oniguruma/release).
const ONIG_WASM_URL = '/onig.wasm';

let isVerseRegistered = false;
let grammarPromise;

class TextMateState {
	constructor(ruleStack) {
		this.ruleStack = ruleStack;
	}

	clone() {
		return new TextMateState(this.ruleStack);
	}

	equals(other) {
		return this.ruleStack === other.ruleStack;
	}
}

function normalizeFontStyle(fontStyle = '') {
	return fontStyle.trim();
}

function toMonacoTheme(theme) {
	const rules = theme.tokenColors.flatMap((entry) => {
		const scopes = Array.isArray(entry.scope) ? entry.scope : [entry.scope];

		return scopes
			.filter(Boolean)
			.map((scope) => ({
				token: scope,
				foreground: entry.settings?.foreground?.replace('#', ''),
				fontStyle: normalizeFontStyle(entry.settings?.fontStyle),
			}));
	});

	return {
		base: 'vs-dark',
		inherit: true,
		rules,
		colors: {
			...theme.colors,
			'editor.background': '#1f1f1f',
		},
	};
}

function toRegExp(pattern) {
	return pattern ? new RegExp(pattern) : undefined;
}

function normalizePair(pair) {
	if (Array.isArray(pair)) {
		const [open, close] = pair;
		return { open, close };
	}

	return pair;
}

function getAutoClosingPairs() {
	const pairs = languageConfiguration.autoClosingPairs
		?? languageConfiguration['autoClosingPairs-disabled']
		?? [];

	return pairs.map(normalizePair);
}

function getSurroundingPairs() {
	const pairs = languageConfiguration.surroundingPairs
		?? languageConfiguration['surroundingPairs-disabled']
		?? [];

	return pairs.map(normalizePair);
}

function getMostSpecificScope(scopes) {
	return [...scopes].reverse().find((scope) => scope !== VERSE_SCOPE_NAME) ?? VERSE_SCOPE_NAME;
}

async function getVerseGrammar() {
	if (!grammarPromise) {
		grammarPromise = (async () => {
			const wasm = await fetch(ONIG_WASM_URL).then((response) => response.arrayBuffer());
			await loadWASM(wasm);

			const registry = new Registry({
				onigLib: Promise.resolve({
					createOnigScanner(patterns) {
						return new OnigScanner(patterns);
					},
					createOnigString(value) {
						return new OnigString(value);
					},
				}),
				loadGrammar: async (scopeName) => {
					if (scopeName !== VERSE_SCOPE_NAME) {
						return null;
					}

					return parseRawGrammar(
						JSON.stringify(verseGrammar),
						'verse.tmLanguage.json',
					);
				},
			});

			return registry.loadGrammar(VERSE_SCOPE_NAME);
		})();
	}

	return grammarPromise;
}

export async function registerVerseLanguage(monaco) {
	if (isVerseRegistered) {
		return;
	}
	isVerseRegistered = true;

	monaco.languages.register({ id: VERSE_LANGUAGE_ID, extensions: ['.verse'] });

	monaco.languages.setLanguageConfiguration(VERSE_LANGUAGE_ID, {
		comments: languageConfiguration.comments,
		brackets: languageConfiguration.brackets,
		indentationRules: {
			increaseIndentPattern: toRegExp(languageConfiguration.indentationRules?.increaseIndentPattern),
			decreaseIndentPattern: toRegExp(languageConfiguration.indentationRules?.decreaseIndentPattern),
		},
		autoClosingPairs: getAutoClosingPairs(),
		surroundingPairs: getSurroundingPairs(),
	});

	monaco.editor.defineTheme('verse-dark', toMonacoTheme(verseTheme));

	registerVerseIntellisense(monaco);

	const grammar = await getVerseGrammar();

	monaco.languages.setTokensProvider(VERSE_LANGUAGE_ID, {
		getInitialState() {
			return new TextMateState(INITIAL);
		},

		tokenize(line, state) {
			const stack = state instanceof TextMateState ? state.ruleStack : INITIAL;
			const tokenizedLine = grammar.tokenizeLine(line, stack);

			return {
				endState: new TextMateState(tokenizedLine.ruleStack),
				tokens: tokenizedLine.tokens.map((token) => ({
					startIndex: token.startIndex,
					scopes: getMostSpecificScope(token.scopes),
				})),
			};
		},
	});
}
