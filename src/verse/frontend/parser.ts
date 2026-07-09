// parser.ts
// Recursive-descent parser for Verse. Consumes the token stream from
// lexer.ts (indent/dedent/newline tokens carry block structure) and produces
// the AST in ast.ts.
//
// Grammar reference: Epic's hand-written parser in the public UE6 stream
// (Engine/Source/Runtime/VerseCompiler, uLang/Parser). Like Epic's parser,
// declaration heads are recognized with bounded backtracking: we try to read
// `Name<specs>(params)<effects> :` / `:=` and rewind into expression parsing
// if the shape doesn't match.

import {
	Attribute, ArrayLit, Block, CallArg, CaseArm, ClassDef, Expr, ForGenerator,
	IfClause, MapLit, Param, Program, Specifier, WhereClause,
	isDefinitionNode,
} from './ast';
import { lex, VerseSyntaxError } from './lexer';
import {
	describeToken, isKeyword, RESERVED_FUTURE_KEYWORDS, Span, Token,
} from './tokens';

export { VerseSyntaxError };

const COMPARISON_OPS = new Set(['=', '<>', '<', '<=', '>', '>=']);
const ADDITIVE_OPS = new Set(['+', '-']);
const MULTIPLICATIVE_OPS = new Set(['*', '/']);
const SET_OPS = new Set(['=', '+=', '-=', '*=', '/=']);
const CONCURRENCY_KEYWORDS = new Set(['race', 'sync', 'rush', 'branch']);

export function parseVerse(source: string): Program {
	const tokens = lex(source);
	return new Parser(tokens, source).parseProgram();
}

/** Parses a single expression (used for string interpolation segments). */
export function parseVerseExpression(source: string): Expr {
	const tokens = lex(source);
	const parser = new Parser(tokens, source);
	return parser.parseStandaloneExpression();
}

/**
 * Error-recovering parse for live IDE diagnostics: on a syntax error the
 * parser records it, skips to the next top-level statement boundary, and
 * keeps going, so one typo doesn't hide the rest of the file.
 */
export function parseVerseTolerant(source: string): { program: Program; errors: VerseSyntaxError[] } {
	let tokens: Token[];
	try {
		tokens = lex(source);
	} catch (error) {
		if (error instanceof VerseSyntaxError) {
			return {
				program: {
					kind: 'Program',
					body: [],
					span: { start: error.pos, end: error.endPos ?? error.pos },
				},
				errors: [error],
			};
		}
		throw error;
	}
	return new Parser(tokens, source).parseProgramTolerant();
}

class Parser {
	private tokens: Token[];
	private i = 0;
	private source: string;

	constructor(tokens: Token[], source: string) {
		this.tokens = tokens;
		this.source = source;
	}

	// --- token helpers ---

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
	}

	private next(): Token {
		const token = this.tokens[this.i];
		if (this.i < this.tokens.length - 1) {
			this.i += 1;
		}
		return token;
	}

	private at(kind: Token['kind'], text?: string): boolean {
		const token = this.peek();
		return token.kind === kind && (text === undefined || token.text === text);
	}

	private atIdent(name: string): boolean {
		return this.at('ident', name);
	}

	private eat(kind: Token['kind'], text?: string): Token | null {
		if (this.at(kind, text)) {
			return this.next();
		}
		return null;
	}

	private expect(kind: Token['kind'], text: string | undefined, what: string): Token {
		const token = this.eat(kind, text);
		if (!token) {
			throw this.error(`Expected ${what} but found ${describeToken(this.peek())}`);
		}
		return token;
	}

	private error(message: string, span?: Span): VerseSyntaxError {
		const at = span ?? this.peek().span;
		return new VerseSyntaxError(message, at.start, at.end);
	}

	private mark(): number {
		return this.i;
	}

	private reset(mark: number): void {
		this.i = mark;
	}

	private skipNewlines(): void {
		while (this.at('newline')) {
			this.next();
		}
	}

	private spanFrom(startToken: Token, endToken?: Token): Span {
		const end = endToken ?? this.tokens[Math.max(0, this.i - 1)];
		return { start: startToken.span.start, end: end.span.end };
	}

	private spanOfExprs(start: Span, end: Span): Span {
		return { start: start.start, end: end.end };
	}

	// --- program ---

	parseProgram(): Program {
		const body: Expr[] = [];
		const first = this.peek();
		this.skipNewlines();
		while (!this.at('eof')) {
			if (this.at('dedent') || this.at('indent')) {
				// Tolerate stray indentation at top level (recover gracefully).
				this.next();
				this.skipNewlines();
				continue;
			}
			body.push(this.parseStatement());
			this.skipStatementSeparators();
		}
		return { kind: 'Program', body, span: this.spanFrom(first) };
	}

	parseProgramTolerant(): { program: Program; errors: VerseSyntaxError[] } {
		const body: Expr[] = [];
		const errors: VerseSyntaxError[] = [];
		const first = this.peek();
		this.skipNewlines();
		while (!this.at('eof')) {
			if (this.at('dedent') || this.at('indent')) {
				this.next();
				this.skipNewlines();
				continue;
			}
			try {
				body.push(this.parseStatement());
				this.skipStatementSeparators();
			} catch (error) {
				if (!(error instanceof VerseSyntaxError)) {
					throw error;
				}
				errors.push(error);
				this.recoverToTopLevel();
			}
		}
		return { program: { kind: 'Program', body, span: this.spanFrom(first) }, errors };
	}

	/** Skips to the next newline at top indentation (indents balanced). */
	private recoverToTopLevel(): void {
		let depth = 0;
		while (!this.at('eof')) {
			if (this.at('indent')) {
				depth += 1;
			} else if (this.at('dedent')) {
				depth -= 1;
			} else if (this.at('newline') && depth <= 0) {
				this.next();
				this.skipNewlines();
				return;
			}
			this.next();
		}
	}

	parseStandaloneExpression(): Expr {
		this.skipNewlines();
		const expr = this.parseExpression();
		this.skipNewlines();
		if (!this.at('eof')) {
			throw this.error(`Unexpected ${describeToken(this.peek())} after expression`);
		}
		return expr;
	}

	private skipStatementSeparators(): void {
		while (this.at('newline') || this.at('op', ';')) {
			this.next();
		}
	}

	private atStatementEnd(): boolean {
		return (
			this.at('newline') || this.at('op', ';') || this.at('dedent') ||
			this.at('op', '}') || this.at('eof')
		);
	}

	// --- statements ---

	private parseStatement(): Expr {
		const attributes = this.parseAttributes();

		if (this.atIdent('using')) {
			return this.parseUsing();
		}
		if (this.atIdent('var')) {
			return this.parseVarDefinition(attributes);
		}
		if (this.atIdent('set')) {
			return this.parseSet();
		}
		if (this.atIdent('return')) {
			const kw = this.next();
			const value = this.atStatementEnd() ? null : this.parseExpression();
			return { kind: 'ReturnExpr', value, span: this.spanFrom(kw) };
		}
		if (this.atIdent('break')) {
			const kw = this.next();
			return { kind: 'BreakExpr', span: this.spanFrom(kw) };
		}
		if (this.atIdent('defer')) {
			const kw = this.next();
			const body = this.parseBodyIntro('defer');
			return { kind: 'DeferExpr', body, span: this.spanFrom(kw) };
		}

		// Declarations (Name<specs>(params) : type = ..., Name := ..., etc.)
		const decl = this.tryParseDeclaration(attributes);
		if (decl) {
			return decl;
		}

		if (attributes.length > 0) {
			throw this.error('Attributes must be followed by a definition');
		}

		return this.parseExpression();
	}

	private parseAttributes(): Attribute[] {
		const attributes: Attribute[] = [];
		while (this.at('op', '@')) {
			const atTok = this.next();
			const nameTok = this.expect('ident', undefined, 'attribute name');
			const args: Expr[] = [];
			if (this.at('op', '(') && !this.peek().spaceBefore) {
				this.next();
				while (!this.at('op', ')')) {
					args.push(this.parseExpression());
					if (!this.eat('op', ',')) {
						break;
					}
				}
				this.expect('op', ')', "')' to close attribute arguments");
			}
			attributes.push({ name: nameTok.text, args, span: this.spanFrom(atTok) });
			// Attributes may sit on their own line above the definition.
			this.skipNewlines();
		}
		return attributes;
	}

	private parseUsing(): Expr {
		const kw = this.next(); // using
		this.expect('op', '{', "'{' after 'using'");
		let path = '';
		while (!this.at('op', '}') && !this.at('eof')) {
			path += this.next().text;
		}
		this.expect('op', '}', "'}' to close 'using' declaration");
		return { kind: 'UsingDecl', path: path.trim(), span: this.spanFrom(kw) };
	}

	private parseVarDefinition(attributes: Attribute[]): Expr {
		const kw = this.next(); // var
		const nameTok = this.expect('ident', undefined, 'variable name');
		this.checkNameNotReserved(nameTok);
		const specifiers = this.parseSpecifiers();
		let type: Expr | null = null;
		let value: Expr | null = null;
		if (this.eat('op', ':')) {
			type = this.parseType();
			if (this.eat('op', '=')) {
				value = this.parseBodyAfterEquals();
			}
		} else if (this.eat('op', ':=')) {
			value = this.parseBodyAfterEquals();
		} else {
			throw this.error("Expected ':' or ':=' after variable name");
		}
		return {
			kind: 'VarDefinition',
			name: nameTok.text,
			specifiers,
			attributes,
			type,
			value,
			span: this.spanFrom(kw),
		};
	}

	private parseSet(): Expr {
		const kw = this.next(); // set
		const target = this.parsePostfix(this.parsePrimary());
		const opTok = this.peek();
		if (opTok.kind !== 'op' || !SET_OPS.has(opTok.text)) {
			throw this.error("Expected '=', '+=', '-=', '*=' or '/=' in 'set' expression");
		}
		this.next();
		const value = this.parseExpression();
		return {
			kind: 'SetExpr',
			target,
			op: opTok.text as '=' | '+=' | '-=' | '*=' | '/=',
			value,
			span: this.spanFrom(kw),
		};
	}

	private checkNameNotReserved(token: Token): void {
		if (RESERVED_FUTURE_KEYWORDS.has(token.text)) {
			throw this.error(
				`'${token.text}' is reserved for future use and cannot be used as a name`,
				token.span,
			);
		}
		if (isKeyword(token.text)) {
			throw this.error(`'${token.text}' is a reserved word and cannot be used as a name`, token.span);
		}
	}

	// --- declarations ---

	private tryParseDeclaration(attributes: Attribute[]): Expr | null {
		const start = this.mark();
		const startTok = this.peek();

		// Extension method head: (Name : Type).Method(params)...
		let extensionTarget: Expr | null = null;
		let extensionSelfName: string | null = null;
		if (this.at('op', '(')) {
			const saved = this.mark();
			try {
				this.next();
				if (this.at('ident') && !isKeyword(this.peek().text) && this.peek(1).kind === 'op' && this.peek(1).text === ':') {
					extensionSelfName = this.next().text;
					this.next(); // :
				}
				const target = this.parseType();
				if (this.eat('op', ')') && this.eat('op', '.')) {
					extensionTarget = target;
				} else {
					this.reset(saved);
					return null;
				}
			} catch {
				this.reset(saved);
				return null;
			}
		}

		if (
			this.at('ident') && RESERVED_FUTURE_KEYWORDS.has(this.peek().text) &&
			this.peek(1).kind === 'op' &&
			// `name :=`, `name :`, `name(` (function definition), `name<spec>`
			(this.peek(1).text === ':=' || this.peek(1).text === ':' ||
				(this.peek(1).text === '(' && !this.peek(1).spaceBefore) ||
				(this.peek(1).text === '<' && !this.peek(1).spaceBefore))
		) {
			throw this.error(
				`'${this.peek().text}' is reserved for future use and cannot be used as a name`,
				this.peek().span,
			);
		}
		if (!this.at('ident') || isKeyword(this.peek().text)) {
			this.reset(start);
			return null;
		}
		const nameTok = this.next();
		const specifiers = this.parseSpecifiers();

		let params: Param[] | null = null;
		let where: WhereClause[] = [];
		let effects: Specifier[] = [];
		if (this.at('op', '(') && !this.peek().spaceBefore) {
			const saved = this.mark();
			const parsed = this.tryParseParamList();
			if (parsed) {
				params = parsed.params;
				where = parsed.where;
				effects = this.parseSpecifiers();
			} else {
				this.reset(saved);
			}
		}

		if (this.at('op', ':=')) {
			this.next();
			return this.finishDefinitionWithValue(
				startTok, nameTok.text, specifiers, attributes, params, where, effects,
				null, extensionTarget, extensionSelfName,
			);
		}
		if (this.at('op', ':')) {
			this.next();
			const type = this.parseType();
			if (this.eat('op', '=')) {
				return this.finishDefinitionWithValue(
					startTok, nameTok.text, specifiers, attributes, params, where, effects,
					type, extensionTarget, extensionSelfName,
				);
			}
			if (this.atStatementEnd()) {
				// Declaration without a body: abstract method or bare field.
				if (params !== null) {
					return {
						kind: 'FunctionDef',
						name: nameTok.text,
						specifiers,
						effects,
						attributes,
						params,
						where,
						returnType: type,
						body: null,
						extensionTarget,
						extensionSelfName: extensionSelfName ?? undefined,
						span: this.spanFrom(startTok),
					};
				}
				return {
					kind: 'Definition',
					name: nameTok.text,
					specifiers,
					attributes,
					type,
					value: null,
					span: this.spanFrom(startTok),
				};
			}
			this.reset(start);
			return null;
		}

		this.reset(start);
		return null;
	}

	private finishDefinitionWithValue(
		startTok: Token,
		name: string,
		specifiers: Specifier[],
		attributes: Attribute[],
		params: Param[] | null,
		where: WhereClause[],
		effects: Specifier[],
		declaredType: Expr | null,
		extensionTarget: Expr | null,
		extensionSelfName: string | null = null,
	): Expr {
		// RHS keyword forms produce named type/module definitions.
		if (this.atIdent('class') || this.atIdent('struct') || this.atIdent('interface')) {
			return this.parseClassDef(startTok, name, specifiers, attributes, params ?? []);
		}
		if (this.atIdent('module')) {
			return this.parseModuleDef(startTok, name, specifiers, attributes);
		}
		if (this.atIdent('enum')) {
			return this.parseEnumDef(startTok, name, specifiers, attributes);
		}
		if (this.atIdent('type') && declaredType === null && params === null) {
			// Type alias: pair := type{tuple(int, int)} or `t := type ...`
			const value = this.parseExpression();
			return { kind: 'TypeAliasDef', name, value, span: this.spanFrom(startTok) };
		}

		const body = this.parseBodyAfterEquals();
		if (params !== null) {
			return {
				kind: 'FunctionDef',
				name,
				specifiers,
				effects,
				attributes,
				params,
				where,
				returnType: declaredType,
				body,
				extensionTarget,
				extensionSelfName: extensionSelfName ?? undefined,
				span: this.spanFrom(startTok),
			};
		}
		return {
			kind: 'Definition',
			name,
			specifiers,
			attributes,
			type: declaredType,
			value: body,
			span: this.spanFrom(startTok),
		};
	}

	/** Parses `<spec><spec2>` chains (no space before `<`). */
	private parseSpecifiers(): Specifier[] {
		const specifiers: Specifier[] = [];
		while (
			this.at('op', '<') &&
			!this.peek().spaceBefore &&
			this.peek(1).kind === 'ident' &&
			(this.peek(2).kind === 'op' && (this.peek(2).text === '>' || this.peek(2).text === '{' || this.peek(2).text === '('))
		) {
			const lt = this.next();
			const nameTok = this.next();
			let arg: string | undefined;
			if (this.at('op', '{') || this.at('op', '(')) {
				const open = this.next().text;
				const close = open === '{' ? '}' : ')';
				let raw = '';
				let depth = 1;
				while (!this.at('eof')) {
					const token = this.peek();
					if (token.kind === 'op' && token.text === open) {
						depth += 1;
					}
					if (token.kind === 'op' && token.text === close) {
						depth -= 1;
						if (depth === 0) {
							break;
						}
					}
					raw += this.next().text + ' ';
				}
				this.expect('op', close, `'${close}' in specifier argument`);
				arg = raw.trim();
			}
			this.expect('op', '>', "'>' to close specifier");
			specifiers.push({ name: nameTok.text, arg, span: this.spanFrom(lt) });
		}
		return specifiers;
	}

	private tryParseParamList(): { params: Param[]; where: WhereClause[] } | null {
		if (!this.at('op', '(')) {
			return null;
		}
		const saved = this.mark();
		try {
			this.next(); // (
			const params: Param[] = [];
			const where: WhereClause[] = [];
			while (!this.at('op', ')')) {
				if (this.atIdent('where')) {
					this.next();
					do {
						const nameTok = this.expect('ident', undefined, 'type parameter name');
						let constraint: Expr | null = null;
						if (this.eat('op', ':')) {
							constraint = this.parseType();
						}
						where.push({ name: nameTok.text, constraint, span: nameTok.span });
					} while (this.eat('op', ','));
					break;
				}

				const startTok = this.peek();
				let named = false;
				if (this.at('op', '?')) {
					named = true;
					this.next();
				}
				let name: string;
				let type: Expr | null = null;
				if (this.at('op', ':')) {
					// Unnamed parameter `:type` (appears in type positions).
					this.next();
					name = `$${params.length}`;
					type = this.parseType();
				} else {
					const nameTok = this.peek();
					if (nameTok.kind !== 'ident' || (isKeyword(nameTok.text) && nameTok.text !== '_')) {
						return null;
					}
					this.next();
					name = nameTok.text;
					if (this.eat('op', ':')) {
						type = this.parseType();
					} else if (!this.at('op', ':=')) {
						// A bare identifier isn't a parameter; bail to expression.
						return null;
					}
				}
				let defaultValue: Expr | null = null;
				if (this.eat('op', ':=') || this.eat('op', '=')) {
					defaultValue = this.parseExpression();
				}
				params.push({ name, named, type, defaultValue, span: startTok.span });
				if (!this.eat('op', ',')) {
					if (this.atIdent('where')) {
						continue; // `where` may follow the last param directly
					}
					break;
				}
			}
			if (!this.eat('op', ')')) {
				this.reset(saved);
				return null;
			}
			return { params, where };
		} catch {
			this.reset(saved);
			return null;
		}
	}

	// --- class / module / enum ---

	private parseClassDef(
		startTok: Token,
		name: string,
		specifiers: Specifier[],
		attributes: Attribute[],
		typeParams: Param[],
	): ClassDef {
		const kwTok = this.next(); // class | struct | interface
		const classKind = kwTok.text as 'class' | 'struct' | 'interface';
		const classSpecifiers = this.parseSpecifiers();
		const supers: Expr[] = [];
		if (this.at('op', '(')) {
			this.next();
			while (!this.at('op', ')')) {
				supers.push(this.parseType());
				if (!this.eat('op', ',')) {
					break;
				}
			}
			this.expect('op', ')', "')' to close superclass list");
		}
		const members: Expr[] = [];
		const blocks: Expr[] = [];
		const body = this.parseDeclarationBody(`${classKind} body`);
		for (const member of body) {
			if (member.kind === 'Block' && member.label === 'block') {
				blocks.push(member);
			} else {
				members.push(member);
			}
		}
		return {
			kind: 'ClassDef',
			name,
			classKind,
			specifiers: [...specifiers, ...classSpecifiers],
			attributes,
			typeParams,
			supers,
			members,
			blocks,
			span: this.spanFrom(startTok),
		};
	}

	private parseModuleDef(
		startTok: Token,
		name: string,
		specifiers: Specifier[],
		attributes: Attribute[],
	): Expr {
		this.next(); // module
		const moduleSpecifiers = this.parseSpecifiers();
		const members = this.parseDeclarationBody('module body');
		return {
			kind: 'ModuleDef',
			name,
			specifiers: [...specifiers, ...moduleSpecifiers],
			attributes,
			members,
			span: this.spanFrom(startTok),
		};
	}

	private parseEnumDef(
		startTok: Token,
		name: string,
		specifiers: Specifier[],
		attributes: Attribute[],
	): Expr {
		this.next(); // enum
		const enumSpecifiers = this.parseSpecifiers();
		const values: { name: string; span: Span }[] = [];
		if (this.at('op', '{')) {
			this.next();
			while (!this.at('op', '}')) {
				const tok = this.expect('ident', undefined, 'enum value name');
				values.push({ name: tok.text, span: tok.span });
				if (!this.eat('op', ',')) {
					break;
				}
			}
			this.expect('op', '}', "'}' to close enum");
		} else {
			this.expect('op', ':', "'{' or ':' after 'enum'");
			this.expect('newline', undefined, 'newline after enum header');
			this.expect('indent', undefined, 'indented enum values');
			while (!this.at('dedent') && !this.at('eof')) {
				if (this.at('newline')) {
					this.next();
					continue;
				}
				const tok = this.expect('ident', undefined, 'enum value name');
				values.push({ name: tok.text, span: tok.span });
				this.eat('op', ',');
			}
			this.eat('dedent');
		}
		return {
			kind: 'EnumDef',
			name,
			specifiers: [...specifiers, ...enumSpecifiers],
			attributes,
			values,
			span: this.spanFrom(startTok),
		};
	}

	/** Parses `: <indented members>` or `{ members }` for class/module bodies. */
	private parseDeclarationBody(what: string): Expr[] {
		const members: Expr[] = [];
		if (this.at('op', '{')) {
			this.next();
			while (!this.at('op', '}') && !this.at('eof')) {
				if (this.at('newline') || this.at('op', ';')) {
					this.next();
					continue;
				}
				members.push(this.parseClassLevelStatement());
			}
			this.expect('op', '}', `'}' to close ${what}`);
			return members;
		}
		this.expect('op', ':', `':' or '{' to open ${what}`);
		if (this.at('newline')) {
			this.next();
			if (!this.at('indent')) {
				return members; // empty body
			}
			this.next();
			while (!this.at('dedent') && !this.at('eof')) {
				if (this.at('newline') || this.at('op', ';')) {
					this.next();
					continue;
				}
				members.push(this.parseClassLevelStatement());
			}
			this.eat('dedent');
			return members;
		}
		// Single-line body.
		while (!this.atStatementEnd()) {
			members.push(this.parseClassLevelStatement());
			if (!this.eat('op', ';')) {
				break;
			}
		}
		return members;
	}

	private parseClassLevelStatement(): Expr {
		if (this.atIdent('block')) {
			const kw = this.next();
			const body = this.parseBodyIntro('block');
			return { kind: 'Block', exprs: [body], label: 'block', span: this.spanFrom(kw) };
		}
		const statement = this.parseStatement();
		this.skipStatementSeparators();
		return statement;
	}

	// --- bodies ---

	/** After `=`: an indented block, a braced block, or inline statement(s). */
	private parseBodyAfterEquals(): Expr {
		if (this.at('newline')) {
			return this.parseIndentedBlock();
		}
		if (this.at('op', '{')) {
			return this.parseBracedBlock();
		}
		return this.parseInlineBody();
	}

	/** After a construct keyword: `:` + block/inline, or `{...}`. */
	private parseBodyIntro(what: string): Expr {
		if (this.at('op', '{')) {
			return this.parseBracedBlock();
		}
		this.expect('op', ':', `':' or '{' after '${what}'`);
		if (this.at('newline')) {
			return this.parseIndentedBlock();
		}
		return this.parseInlineBody();
	}

	private parseIndentedBlock(): Block {
		const startTok = this.peek();
		this.expect('newline', undefined, 'newline before indented block');
		this.expect('indent', undefined, 'indented block');
		const exprs: Expr[] = [];
		while (!this.at('dedent') && !this.at('eof')) {
			if (this.at('newline') || this.at('op', ';')) {
				this.next();
				continue;
			}
			exprs.push(this.parseStatement());
			this.skipStatementSeparators();
		}
		this.eat('dedent');
		return { kind: 'Block', exprs, label: 'braces', span: this.spanFrom(startTok) };
	}

	private parseBracedBlock(): Block {
		const open = this.expect('op', '{', "'{'");
		const exprs: Expr[] = [];
		while (!this.at('op', '}') && !this.at('eof')) {
			if (this.at('newline') || this.at('op', ';')) {
				this.next();
				continue;
			}
			exprs.push(this.parseStatement());
			while (this.at('op', ';') || this.at('newline')) {
				this.next();
			}
		}
		this.expect('op', '}', "'}' to close block");
		return { kind: 'Block', exprs, label: 'braces', span: this.spanFrom(open) };
	}

	private parseInlineBody(): Expr {
		const startTok = this.peek();
		const exprs: Expr[] = [this.parseStatement()];
		while (this.eat('op', ';')) {
			if (this.atStatementEnd()) {
				break;
			}
			exprs.push(this.parseStatement());
		}
		if (exprs.length === 1) {
			return exprs[0];
		}
		return { kind: 'Block', exprs, label: 'braces', span: this.spanFrom(startTok) };
	}

	// --- control flow ---

	private parseIf(): Expr {
		const kw = this.next(); // if
		const clauses: IfClause[] = [];
		let elseBody: Expr | null = null;

		const firstConditions = this.parseConditionList();

		if (this.atIdent('then')) {
			this.next();
			const thenBody = this.parseInlineOrIndented();
			let elseExpr: Expr | null = null;
			this.skipNewlinesBeforeElse();
			if (this.atIdent('else')) {
				this.next();
				elseExpr = this.parseInlineOrIndented();
			}
			clauses.push({
				conditions: firstConditions,
				body: thenBody,
				span: this.spanFrom(kw),
			});
			return { kind: 'IfExpr', clauses, elseBody: elseExpr, span: this.spanFrom(kw) };
		}

		const firstBody = this.parseBodyIntro('if');
		clauses.push({ conditions: firstConditions, body: firstBody, span: this.spanFrom(kw) });

		for (;;) {
			this.skipNewlinesBeforeElse();
			if (!this.atIdent('else')) {
				break;
			}
			this.next(); // else
			if (this.atIdent('if')) {
				this.next();
				const conditions = this.parseConditionList();
				const body = this.parseBodyIntro('else if');
				clauses.push({ conditions, body, span: this.spanFrom(kw) });
				continue;
			}
			elseBody = this.parseBodyIntro('else');
			break;
		}

		return { kind: 'IfExpr', clauses, elseBody, span: this.spanFrom(kw) };
	}

	/**
	 * `else` may follow the previous block after newlines (same indent level,
	 * so no dedent intervenes at the top level of the block).
	 */
	private skipNewlinesBeforeElse(): void {
		const saved = this.mark();
		this.skipNewlines();
		if (!this.atIdent('else')) {
			this.reset(saved);
		}
	}

	private parseConditionList(): Expr[] {
		this.expect('op', '(', "'(' after 'if'");
		const conditions: Expr[] = [];
		while (!this.at('op', ')')) {
			conditions.push(this.parseConditionItem());
			if (!this.eat('op', ',')) {
				break;
			}
		}
		this.expect('op', ')', "')' to close condition list");
		return conditions;
	}

	private parseConditionItem(): Expr {
		// Bindings: `X := expr` and `X : type = expr` (rare).
		if (this.at('ident') && !isKeyword(this.peek().text) && this.peek(1).kind === 'op' && this.peek(1).text === ':=') {
			const nameTok = this.next();
			this.next(); // :=
			const value = this.parseExpression();
			return { kind: 'Assignment', name: nameTok.text, type: null, value, span: this.spanFrom(nameTok) };
		}
		// Failable mutation: `set X = ...`, `set A[I] = ...`.
		if (this.atIdent('set')) {
			return this.parseSet();
		}
		return this.parseExpression();
	}

	private parseInlineOrIndented(): Expr {
		if (this.at('newline')) {
			return this.parseIndentedBlock();
		}
		if (this.at('op', '{')) {
			return this.parseBracedBlock();
		}
		return this.parseExpression();
	}

	private parseCase(): Expr {
		const kw = this.next(); // case
		this.expect('op', '(', "'(' after 'case'");
		const subject = this.parseExpression();
		this.expect('op', ')', "')' after case subject");
		this.expect('op', ':', "':' after 'case (...)'");
		this.expect('newline', undefined, 'newline after case header');
		this.expect('indent', undefined, 'indented case arms');
		const arms: CaseArm[] = [];
		while (!this.at('dedent') && !this.at('eof')) {
			if (this.at('newline') || this.at('op', ';')) {
				this.next();
				continue;
			}
			const armStart = this.peek();
			let pattern: Expr | null;
			if (this.atIdent('_')) {
				this.next();
				pattern = null;
			} else {
				pattern = this.parseExpression();
			}
			this.expect('op', '=>', "'=>' after case pattern");
			const body = this.parseInlineOrIndented();
			arms.push({ pattern, body, span: this.spanFrom(armStart) });
			this.skipStatementSeparators();
		}
		this.eat('dedent');
		return { kind: 'CaseExpr', subject, arms, span: this.spanFrom(kw) };
	}

	private parseFor(): Expr {
		const kw = this.next(); // for
		this.expect('op', '(', "'(' after 'for'");
		const generators: ForGenerator[] = [];
		const filters: Expr[] = [];
		while (!this.at('op', ')')) {
			const itemStart = this.peek();
			// K -> V : Map
			if (
				this.at('ident') && !isKeyword(this.peek().text) &&
				this.peek(1).kind === 'op' && this.peek(1).text === '->'
			) {
				const keyTok = this.next();
				this.next(); // ->
				const valueTok = this.expect('ident', undefined, 'map value variable');
				this.expect('op', ':', "':' after map iteration variables");
				const iterable = this.parseExpression();
				generators.push({
					name: keyTok.text,
					valueName: valueTok.text,
					iterable,
					span: this.spanFrom(itemStart),
				});
			} else if (
				this.at('ident') && !isKeyword(this.peek().text) &&
				this.peek(1).kind === 'op' && (this.peek(1).text === ':' || this.peek(1).text === ':=')
			) {
				const nameTok = this.next();
				this.next(); // : or :=
				const iterable = this.parseExpression();
				generators.push({
					name: nameTok.text,
					valueName: null,
					iterable,
					span: this.spanFrom(itemStart),
				});
			} else {
				filters.push(this.parseExpression());
			}
			if (!this.eat('op', ',')) {
				break;
			}
		}
		this.expect('op', ')', "')' to close 'for'");
		if (this.atIdent('do')) {
			this.next();
		}
		const body = this.parseBodyIntro('for');
		return { kind: 'ForExpr', generators, filters, body, span: this.spanFrom(kw) };
	}

	private parseLoop(): Expr {
		const kw = this.next(); // loop
		const body = this.parseBodyIntro('loop');
		return { kind: 'LoopExpr', body, span: this.spanFrom(kw) };
	}

	private parseWhile(): Expr {
		const kw = this.next(); // while (extension: not in shipping Verse)
		this.expect('op', '(', "'(' after 'while'");
		const condition = this.parseExpression();
		this.expect('op', ')', "')' after while condition");
		const body = this.parseBodyIntro('while');
		return { kind: 'WhileExpr', condition, body, span: this.spanFrom(kw) };
	}

	private parseSpawn(): Expr {
		const kw = this.next(); // spawn
		const body = this.parseBodyIntro('spawn');
		return { kind: 'SpawnExpr', body, span: this.spanFrom(kw) };
	}

	private parseConcurrency(op: 'race' | 'sync' | 'rush' | 'branch'): Expr {
		const kw = this.next();
		if (op === 'branch') {
			const body = this.parseBodyIntro('branch');
			return { kind: 'ConcurrencyBlock', op, clauses: [body], span: this.spanFrom(kw) };
		}
		const body = this.parseBodyIntro(op);
		const clauses = body.kind === 'Block' ? body.exprs : [body];
		return { kind: 'ConcurrencyBlock', op, clauses, span: this.spanFrom(kw) };
	}

	private parseProfile(): Expr {
		const kw = this.next(); // profile
		let label: Expr | null = null;
		if (this.at('op', '(')) {
			this.next();
			label = this.parseExpression();
			this.expect('op', ')', "')' after profile label");
		}
		const body = this.parseBodyIntro('profile');
		return { kind: 'ProfileExpr', label, body, span: this.spanFrom(kw) };
	}

	// --- expressions ---

	parseExpression(): Expr {
		return this.parseOr();
	}

	private parseOr(): Expr {
		let left = this.parseAnd();
		while (this.atIdent('or')) {
			this.next();
			const right = this.parseAnd();
			left = { kind: 'OrExpr', left, right, span: this.spanOfExprs(left.span, right.span) };
		}
		return left;
	}

	private parseAnd(): Expr {
		let left = this.parseNot();
		while (this.atIdent('and')) {
			this.next();
			const right = this.parseNot();
			left = { kind: 'AndExpr', left, right, span: this.spanOfExprs(left.span, right.span) };
		}
		return left;
	}

	private parseNot(): Expr {
		if (this.atIdent('not')) {
			const kw = this.next();
			const operand = this.parseNot();
			return { kind: 'NotExpr', operand, span: this.spanOfExprs(kw.span, operand.span) };
		}
		return this.parseComparison();
	}

	private parseComparison(): Expr {
		let left = this.parseRange();
		while (this.at('op') && COMPARISON_OPS.has(this.peek().text) && !this.isSpecifierAhead()) {
			const opTok = this.next();
			const right = this.parseRange();
			left = {
				kind: 'Binary',
				op: opTok.text as '=' | '<>' | '<' | '<=' | '>' | '>=',
				left,
				right,
				span: this.spanOfExprs(left.span, right.span),
			};
		}
		return left;
	}

	private isSpecifierAhead(): boolean {
		// `<ident>` with no space: specifier, not comparison. Only matters in
		// declaration heads, which don't reach here, but stay conservative.
		return false;
	}

	private parseRange(): Expr {
		const left = this.parseAdditive();
		if (this.at('op', '..')) {
			this.next();
			const right = this.parseAdditive();
			return { kind: 'RangeExpr', low: left, high: right, span: this.spanOfExprs(left.span, right.span) };
		}
		return left;
	}

	private parseAdditive(): Expr {
		let left = this.parseMultiplicative();
		while (this.at('op') && ADDITIVE_OPS.has(this.peek().text)) {
			const opTok = this.next();
			const right = this.parseMultiplicative();
			left = {
				kind: 'Binary',
				op: opTok.text as '+' | '-',
				left,
				right,
				span: this.spanOfExprs(left.span, right.span),
			};
		}
		return left;
	}

	private parseMultiplicative(): Expr {
		let left = this.parseUnary();
		while (this.at('op') && MULTIPLICATIVE_OPS.has(this.peek().text)) {
			const opTok = this.next();
			const right = this.parseUnary();
			left = {
				kind: 'Binary',
				op: opTok.text as '*' | '/',
				left,
				right,
				span: this.spanOfExprs(left.span, right.span),
			};
		}
		return left;
	}

	private parseUnary(): Expr {
		if (this.at('op', '-') || this.at('op', '+')) {
			const opTok = this.next();
			const operand = this.parseUnary();
			return {
				kind: 'Unary',
				op: opTok.text as '-' | '+',
				operand,
				span: this.spanOfExprs(opTok.span, operand.span),
			};
		}
		if (this.at('op', '?')) {
			// Option type in expression position (e.g. cast target `?int`).
			const opTok = this.next();
			const inner = this.parseUnary();
			return { kind: 'OptionType', inner, span: this.spanOfExprs(opTok.span, inner.span) };
		}
		return this.parsePostfix(this.parsePrimary());
	}

	private parsePostfix(expr: Expr): Expr {
		let current = expr;
		for (;;) {
			if (this.at('op', '(') && !this.peek().spaceBefore) {
				current = this.parseCallSuffix(current, false);
				continue;
			}
			if (this.at('op', '[') && !this.peek().spaceBefore) {
				current = this.parseIndexSuffix(current);
				continue;
			}
			if (this.at('op', '.')) {
				this.next();
				const nameTok = this.expect('ident', undefined, 'member name');
				current = {
					kind: 'Member',
					target: current,
					name: nameTok.text,
					span: this.spanOfExprs(current.span, nameTok.span),
				};
				continue;
			}
			if (this.at('op', '?') && !this.peek().spaceBefore) {
				const opTok = this.next();
				current = { kind: 'QueryExpr', operand: current, span: this.spanOfExprs(current.span, opTok.span) };
				continue;
			}
			if (
				this.at('op', '{') &&
				(current.kind === 'Ident' || current.kind === 'Member' || current.kind === 'Call' || current.kind === 'GenericType')
			) {
				current = this.parseArchetypeSuffix(current);
				continue;
			}
			break;
		}
		return current;
	}

	private parseCallSuffix(callee: Expr, failable: boolean): Expr {
		const open = this.next(); // ( or [
		const closeText = failable ? ']' : ')';
		const args: CallArg[] = [];
		while (!this.at('op', closeText)) {
			let name: string | null = null;
			if (
				this.at('op', '?') &&
				this.peek(1).kind === 'ident' &&
				this.peek(2).kind === 'op' && this.peek(2).text === ':='
			) {
				this.next(); // ?
				name = this.next().text;
				this.next(); // :=
			}
			const value = this.parseExpression();
			args.push({ name, value });
			if (!this.eat('op', ',')) {
				break;
			}
		}
		this.expect('op', closeText, `'${closeText}' to close argument list`);
		return {
			kind: 'Call',
			callee,
			args,
			failable,
			span: this.spanOfExprs(callee.span, { start: open.span.start, end: this.tokens[this.i - 1].span.end }),
		};
	}

	private parseIndexSuffix(target: Expr): Expr {
		// `X[...]` is indexing, a failable call, or a cast; sema disambiguates.
		return this.parseCallSuffix(target, true);
	}

	private parseArchetypeSuffix(callee: Expr): Expr {
		const open = this.next(); // {
		const fields: { name: string; value: Expr; span: Span }[] = [];
		const body: Expr[] = [];
		while (!this.at('op', '}') && !this.at('eof')) {
			if (this.at('newline') || this.at('op', ';')) {
				this.next();
				continue;
			}
			const startTok = this.peek();
			if (
				this.at('ident') && !isKeyword(this.peek().text) &&
				this.peek(1).kind === 'op' && this.peek(1).text === ':='
			) {
				const nameTok = this.next();
				this.next(); // :=
				const value = this.parseExpression();
				fields.push({ name: nameTok.text, value, span: this.spanFrom(startTok) });
			} else {
				body.push(this.parseExpression());
			}
			if (!this.eat('op', ',')) {
				if (!this.eat('op', ';')) {
					break;
				}
			}
		}
		this.expect('op', '}', "'}' to close archetype instantiation");
		return {
			kind: 'Archetype',
			callee,
			fields,
			body,
			span: this.spanOfExprs(callee.span, { start: open.span.start, end: this.tokens[this.i - 1].span.end }),
		};
	}

	private parsePrimary(): Expr {
		const token = this.peek();

		if (token.kind === 'int') {
			this.next();
			return { kind: 'IntLit', value: token.value as number, span: token.span };
		}
		if (token.kind === 'float') {
			this.next();
			return { kind: 'FloatLit', value: token.value as number, span: token.span };
		}
		if (token.kind === 'char') {
			this.next();
			return { kind: 'CharLit', value: token.value as string, span: token.span };
		}
		if (token.kind === 'string') {
			this.next();
			return this.buildStringLit(token);
		}

		if (token.kind === 'ident') {
			switch (token.text) {
				case 'true':
					this.next();
					return { kind: 'LogicLit', value: true, span: token.span };
				case 'false':
					this.next();
					return { kind: 'LogicLit', value: false, span: token.span };
				case 'Self':
					this.next();
					return { kind: 'SelfExpr', span: token.span };
				case '_':
					this.next();
					return { kind: 'Placeholder', span: token.span };
				case 'if':
					return this.parseIf();
				case 'case':
					return this.parseCase();
				case 'for':
					return this.parseFor();
				case 'loop':
					return this.parseLoop();
				case 'while':
					return this.parseWhile();
				case 'spawn':
					return this.parseSpawn();
				case 'race':
				case 'sync':
				case 'rush':
				case 'branch':
					if (CONCURRENCY_KEYWORDS.has(token.text)) {
						return this.parseConcurrency(token.text as 'race' | 'sync' | 'rush' | 'branch');
					}
					break;
				case 'block': {
					const kw = this.next();
					const body = this.parseBodyIntro('block');
					const exprs = body.kind === 'Block' ? body.exprs : [body];
					return { kind: 'Block', exprs, label: 'braces', span: this.spanFrom(kw) };
				}
				case 'profile':
					return this.parseProfile();
				case 'array':
					return this.parseArrayLiteral();
				case 'map':
					return this.parseMapLiteral();
				case 'option':
					return this.parseOptionLiteral();
				case 'logic':
					return this.parseLogicConversion();
				case 'type':
					return this.parseTypeLiteral();
				case 'var': {
					// `var` in expression position (e.g. pointer types) is not
					// supported; report clearly.
					throw this.error("'var' is only allowed at the start of a variable declaration");
				}
				default:
					break;
			}

			if (RESERVED_FUTURE_KEYWORDS.has(token.text)) {
				this.next();
				return { kind: 'FailureExpr', keyword: token.text, span: token.span };
			}

			this.next();
			return { kind: 'Ident', name: token.text, span: token.span };
		}

		if (token.kind === 'op' && token.text === '(') {
			return this.parseParenthesized();
		}
		if (token.kind === 'op' && token.text === '[') {
			// `[]t` array type or `[k]v` map type in expression position.
			return this.parseBracketType();
		}

		throw this.error(`Unexpected ${describeToken(token)}`);
	}

	private buildStringLit(token: Token): Expr {
		const parts: (string | Expr)[] = [];
		for (const part of token.parts ?? []) {
			if (part.type === 'text') {
				parts.push(part.text);
			} else {
				try {
					const inner = parseVerseExpression(part.text);
					parts.push(this.offsetExprSpan(inner, part.pos.line - 1, part.pos.col - 1));
				} catch (error) {
					if (error instanceof VerseSyntaxError) {
						throw new VerseSyntaxError(
							`In string interpolation: ${error.message}`,
							token.span.start,
							token.span.end,
						);
					}
					throw error;
				}
			}
		}
		return { kind: 'StringLit', parts, span: token.span };
	}

	private offsetExprSpan(expr: Expr, lineDelta: number, colDelta: number): Expr {
		// Interpolated expressions are parsed from a substring; shift their
		// spans so diagnostics land on the original source.
		const shift = (span: Span): Span => ({
			start: {
				line: span.start.line + lineDelta,
				col: span.start.line === 1 ? span.start.col + colDelta : span.start.col,
				offset: span.start.offset,
			},
			end: {
				line: span.end.line + lineDelta,
				col: span.end.line === 1 ? span.end.col + colDelta : span.end.col,
				offset: span.end.offset,
			},
		});
		const visit = (node: Expr): void => {
			node.span = shift(node.span);
			for (const key of Object.keys(node)) {
				const value = (node as unknown as Record<string, unknown>)[key];
				if (Array.isArray(value)) {
					for (const item of value) {
						if (item && typeof item === 'object' && 'kind' in item && 'span' in item) {
							visit(item as Expr);
						}
					}
				} else if (value && typeof value === 'object' && 'kind' in value && 'span' in value) {
					visit(value as Expr);
				}
			}
		};
		visit(expr);
		return expr;
	}

	private parseParenthesized(): Expr {
		const open = this.next(); // (

		// `(super:)` prefix for super-dispatch: `(super:)Method(...)`.
		if (this.atIdent('super') && this.peek(1).kind === 'op' && this.peek(1).text === ':') {
			this.next();
			this.next();
			this.expect('op', ')', "')' after '(super:'");
			const superIdent: Expr = { kind: 'Ident', name: 'super', span: this.spanFrom(open) };
			// The method name follows directly (no dot) in Verse syntax.
			if (this.at('ident') && !isKeyword(this.peek().text)) {
				const nameTok = this.next();
				return {
					kind: 'Member',
					target: superIdent,
					name: nameTok.text,
					span: this.spanFrom(open),
				};
			}
			return superIdent;
		}

		if (this.at('op', ')')) {
			this.next();
			return { kind: 'Tuple', elements: [], span: this.spanFrom(open) };
		}
		const first = this.parseExpression();
		if (this.at('op', ',')) {
			const elements = [first];
			while (this.eat('op', ',')) {
				if (this.at('op', ')')) {
					break;
				}
				elements.push(this.parseExpression());
			}
			this.expect('op', ')', "')' to close tuple");
			return { kind: 'Tuple', elements, span: this.spanFrom(open) };
		}
		this.expect('op', ')', "')' to close parenthesized expression");
		return first;
	}

	private parseArrayLiteral(): Expr {
		const kw = this.next(); // array
		if (!this.at('op', '{')) {
			return { kind: 'Ident', name: 'array', span: kw.span };
		}
		this.next();
		const elements: Expr[] = [];
		while (!this.at('op', '}')) {
			elements.push(this.parseExpression());
			if (!this.eat('op', ',')) {
				break;
			}
		}
		this.expect('op', '}', "'}' to close array literal");
		const lit: ArrayLit = { kind: 'ArrayLit', elements, span: this.spanFrom(kw) };
		return this.parsePostfix(lit);
	}

	private parseMapLiteral(): Expr {
		const kw = this.next(); // map
		if (!this.at('op', '{')) {
			return { kind: 'Ident', name: 'map', span: kw.span };
		}
		this.next();
		const entries: { key: Expr; value: Expr }[] = [];
		while (!this.at('op', '}')) {
			const key = this.parseExpression();
			this.expect('op', '=>', "'=>' between map key and value");
			const value = this.parseExpression();
			entries.push({ key, value });
			if (!this.eat('op', ',')) {
				break;
			}
		}
		this.expect('op', '}', "'}' to close map literal");
		const lit: MapLit = { kind: 'MapLit', entries, span: this.spanFrom(kw) };
		return this.parsePostfix(lit);
	}

	private parseOptionLiteral(): Expr {
		const kw = this.next(); // option
		if (!this.at('op', '{')) {
			return { kind: 'Ident', name: 'option', span: kw.span };
		}
		this.next();
		let value: Expr | null = null;
		if (!this.at('op', '}')) {
			value = this.parseExpression();
		}
		this.expect('op', '}', "'}' to close option literal");
		return { kind: 'OptionLit', value, span: this.spanFrom(kw) };
	}

	private parseLogicConversion(): Expr {
		const kw = this.next(); // logic
		if (!this.at('op', '{')) {
			return { kind: 'Ident', name: 'logic', span: kw.span };
		}
		this.next();
		const value = this.parseExpression();
		this.expect('op', '}', "'}' to close logic conversion");
		// logic{e} == archetype-style conversion; model as Archetype.
		return {
			kind: 'Archetype',
			callee: { kind: 'Ident', name: 'logic', span: kw.span },
			fields: [],
			body: [value],
			span: this.spanFrom(kw),
		};
	}

	private parseTypeLiteral(): Expr {
		const kw = this.next(); // type
		if (!this.at('op', '{')) {
			return { kind: 'Ident', name: 'type', span: kw.span };
		}
		this.next();
		let raw = '';
		let depth = 1;
		while (!this.at('eof')) {
			const token = this.peek();
			if (token.kind === 'op' && token.text === '{') {
				depth += 1;
			} else if (token.kind === 'op' && token.text === '}') {
				depth -= 1;
				if (depth === 0) {
					break;
				}
			}
			raw += this.next().text + ' ';
		}
		this.expect('op', '}', "'}' to close type expression");
		return { kind: 'TypeLit', raw: raw.trim(), span: this.spanFrom(kw) };
	}

	private parseBracketType(): Expr {
		const open = this.next(); // [
		if (this.at('op', ']')) {
			this.next();
			const element = this.parseType();
			return { kind: 'ArrayType', element, span: this.spanFrom(open) };
		}
		const key = this.parseType();
		this.expect('op', ']', "']' in map type");
		const value = this.parseType();
		return { kind: 'MapType', key, value, span: this.spanFrom(open) };
	}

	// --- types ---

	parseType(): Expr {
		// Option type.
		if (this.at('op', '?')) {
			const opTok = this.next();
			const inner = this.parseType();
			return { kind: 'OptionType', inner, span: this.spanOfExprs(opTok.span, inner.span) };
		}
		// Array or map type.
		if (this.at('op', '[')) {
			return this.parseBracketType();
		}
		// tuple(t1, t2)
		if (this.atIdent('tuple')) {
			const kw = this.next();
			if (this.at('op', '(')) {
				this.next();
				const elements: Expr[] = [];
				while (!this.at('op', ')')) {
					elements.push(this.parseType());
					if (!this.eat('op', ',')) {
						break;
					}
				}
				this.expect('op', ')', "')' to close tuple type");
				return { kind: 'TupleType', elements, span: this.spanFrom(kw) };
			}
			return { kind: 'Ident', name: 'tuple', span: kw.span };
		}
		// type{...} and bare `type`
		if (this.atIdent('type')) {
			return this.parseTypeLiteral();
		}
		// Function type: (t1, t2) -> r
		if (this.at('op', '(')) {
			const open = this.next();
			const params: Expr[] = [];
			while (!this.at('op', ')')) {
				// Allow named params in function types: `Name : type`.
				if (
					this.at('ident') && this.peek(1).kind === 'op' && this.peek(1).text === ':'
				) {
					this.next();
					this.next();
				}
				params.push(this.parseType());
				if (!this.eat('op', ',')) {
					break;
				}
			}
			this.expect('op', ')', "')' in function type");
			const effects = this.parseSpecifiers();
			if (this.eat('op', '->')) {
				const result = this.parseType();
				return {
					kind: 'FunctionType', params, result, effects,
					span: this.spanOfExprs(open.span, result.span),
				};
			}
			if (params.length === 1 && effects.length === 0) {
				return params[0];
			}
			return { kind: 'TupleType', elements: params, span: this.spanFrom(open) };
		}

		// Named type, possibly qualified and/or parameterized.
		const nameTok = this.peek();
		if (nameTok.kind !== 'ident') {
			throw this.error(`Expected a type but found ${describeToken(nameTok)}`);
		}
		this.next();
		let base: Expr = { kind: 'Ident', name: nameTok.text, span: nameTok.span };
		for (;;) {
			if (this.at('op', '.')) {
				this.next();
				const memberTok = this.expect('ident', undefined, 'qualified type name');
				base = {
					kind: 'Member',
					target: base,
					name: memberTok.text,
					span: this.spanOfExprs(base.span, memberTok.span),
				};
				continue;
			}
			if (this.at('op', '(') && !this.peek().spaceBefore) {
				const open = this.next();
				const args: Expr[] = [];
				while (!this.at('op', ')')) {
					args.push(this.parseType());
					if (!this.eat('op', ',')) {
						break;
					}
				}
				this.expect('op', ')', "')' to close type arguments");
				base = {
					kind: 'GenericType', base, args,
					span: this.spanOfExprs(base.span, { start: open.span.start, end: this.tokens[this.i - 1].span.end }),
				};
				continue;
			}
			break;
		}
		if (this.eat('op', '->')) {
			const result = this.parseType();
			return {
				kind: 'FunctionType', params: [base], result, effects: [],
				span: this.spanOfExprs(base.span, result.span),
			};
		}
		return base;
	}
}

export function collectDefinitions(body: Expr[]): Expr[] {
	return body.filter(isDefinitionNode);
}
