// tokens.ts
// Token model and reserved-word tables for the Verse front end.
//
// The keyword table mirrors Epic's authoritative list in the public UE6
// stream: Engine/Source/Runtime/VerseCompiler/Public/uLang/Parser/
// ReservedSymbols.inl (ue6-main). Symbols marked "reserved future" there are
// accepted by the lexer as keywords so the parser can reject them with a
// helpful message instead of a confusing identifier error.

export interface SourcePos {
	/** 1-based line. */
	line: number;
	/** 1-based column. */
	col: number;
	/** 0-based offset into the source string. */
	offset: number;
}

export interface Span {
	start: SourcePos;
	end: SourcePos;
}

export type TokenKind =
	| 'ident'
	| 'int'
	| 'float'
	| 'char'
	| 'string'
	| 'op'
	| 'newline'
	| 'indent'
	| 'dedent'
	| 'eof';

export interface StringPart {
	type: 'text' | 'interp';
	/** Literal text, or raw Verse source of the interpolated expression. */
	text: string;
	/** Position of the part's first character (for interp: inside braces). */
	pos: SourcePos;
}

export interface Token {
	kind: TokenKind;
	/**
	 * For 'op': the operator text. For 'ident': the identifier. For literals:
	 * the raw text.
	 */
	text: string;
	/** Parsed value for int/float/char literals. */
	value?: number | string;
	/** Interpolation-aware parts for string literals. */
	parts?: StringPart[];
	span: Span;
	/** True when whitespace/comments separate this token from the previous. */
	spaceBefore: boolean;
}

// Keywords reserved today (EIsReservedSymbolResult::Reserved in
// ReservedSymbols.inl). `task`, `unknown`, `persistent` are NotReserved there
// and are treated as plain identifiers here too.
export const RESERVED_KEYWORDS: ReadonlySet<string> = new Set([
	'abstract', 'abstracts', 'allocates', 'and', 'any', 'array', 'as',
	'assert', 'backslash', 'bag', 'block', 'branch', 'break', 'case',
	'char16', 'char32', 'char8', 'class', 'closed', 'collection', 'computes',
	'constructor', 'contravariant', 'converges', 'covariant', 'decides',
	'defer', 'element', 'embargo', 'ensure', 'enum', 'external', 'fails',
	'false', 'final', 'find', 'first', 'float', 'float128', 'float16',
	'float32', 'float64', 'fold', 'for', 'function', 'given', 'guard',
	'implies', 'import', 'instance', 'int', 'int16', 'int32', 'int64',
	'int8', 'interacts', 'interface', 'intrinsic', 'introspects',
	'invariant', 'iterates', 'known', 'last', 'let', 'logic', 'loop', 'map',
	'markup', 'module', 'nat', 'nat16', 'nat32', 'nat64', 'nat8', 'native',
	'native_callable', 'open', 'option', 'or', 'over', 'permutation',
	'persistable', 'profile', 'provided', 'race', 'random', 'reads',
	'repeat', 'rush', 'scoped', 'Self', 'sequence', 'set', 'spawn',
	'string', 'string16', 'string32', 'string8', 'struct', 'subclass',
	'subtype', 'succeeds', 'super', 'suspends', 'sync', 'syntax', 'throws',
	'trait', 'transacts', 'true', 'truth', 'try', 'tuple', 'type', '_',
	'union', 'using', 'varies', 'verify', 'void', 'when', 'while', 'writes',
	'not', 'if', 'else', 'then', 'return', 'var', 'where', 'do',
]);

// Reserved for future use: parse, then reject with a targeted diagnostic.
export const RESERVED_FUTURE_KEYWORDS: ReadonlySet<string> = new Set([
	'await', 'batch', 'castable_subtype', 'castable_concrete_subtype',
	'concrete_subtype', 'dictate', 'generator', 'local', 'upon',
]);

// Specifier names that may appear inside <angle brackets> after a name,
// parameter list, or class keyword. Effects per uLang Effects.h plus the
// documented alias specifiers; the rest are member/class specifiers.
export const EFFECT_SPECIFIERS: ReadonlySet<string> = new Set([
	'suspends', 'decides', 'diverges', 'reads', 'writes', 'allocates',
	'dictates', 'no_rollback', 'transacts', 'computes', 'converges',
	'varies', 'predicts',
]);

export const MEMBER_SPECIFIERS: ReadonlySet<string> = new Set([
	'override', 'final', 'native', 'native_callable', 'abstract', 'concrete',
	'unique', 'castable', 'persistable', 'public', 'private', 'protected',
	'internal', 'scoped', 'epic_internal', 'constructor', 'localizes',
	'final_super', 'final_super_base', 'module_scoped_var_weak_map_key',
]);

// Multi-character operators, longest first (order matters for the lexer).
export const OPERATORS: readonly string[] = [
	':=', '+=', '-=', '*=', '/=', '<=', '>=', '<>', '=>', '->', '..',
	'?=',
	'+', '-', '*', '/', '=', '<', '>', '(', ')', '[', ']', '{', '}',
	',', '.', ':', ';', '?', '@', '^', '|', '&',
];

export function isKeyword(name: string): boolean {
	return RESERVED_KEYWORDS.has(name) || RESERVED_FUTURE_KEYWORDS.has(name);
}

export function spanFrom(start: SourcePos, end: SourcePos): Span {
	return { start, end };
}

export function describeToken(token: Token): string {
	switch (token.kind) {
		case 'ident':
			return `'${token.text}'`;
		case 'op':
			return `'${token.text}'`;
		case 'newline':
			return 'end of line';
		case 'indent':
			return 'indented block';
		case 'dedent':
			return 'end of block';
		case 'eof':
			return 'end of file';
		default:
			return `${token.kind} literal '${token.text}'`;
	}
}
