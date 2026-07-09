// analysis.ts
// IDE language services backed by the semantic checker: position -> AST
// node lookup, hover info, go-to-definition, and scope-aware completions.
// Framework-agnostic so it can be unit-tested in Node and wired into
// Monaco providers. Obtain a SourceAnalysis via `host.analyze(source)`,
// then query it with `hoverAt` / `definitionAt` / `completionsAt`.

import { Expr, Program } from './frontend/ast';
import { Span } from './frontend/tokens';
import { semaOf } from './sema/checker';
import type { CompileOutcome, IdeDiagnostic } from './host';
import { Binding, Scope } from './sema/scopes';
import { FuncT, MemberInfo, typeToString } from './sema/types';

/** Semantic snapshot of one source buffer, ready for position queries. */
export interface SourceAnalysis {
	ok: boolean;
	program: Program | null;
	moduleScope: Scope | null;
	diagnostics: IdeDiagnostic[];
}

/** Wraps a compile outcome for IDE queries (used by `host.analyze`). */
export function analysisFromOutcome(outcome: CompileOutcome): SourceAnalysis {
	if (!outcome.ok) {
		return { ok: false, program: null, moduleScope: null, diagnostics: outcome.diagnostics };
	}
	return {
		ok: true,
		program: outcome.program,
		moduleScope: outcome.check.moduleScope,
		diagnostics: outcome.diagnostics,
	};
}

// =====================================================================
// Position -> node lookup
// =====================================================================

interface NodeLike {
	kind: string;
	span: Span;
}

function isNodeLike(value: unknown): value is NodeLike {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as { kind?: unknown; span?: { start?: { line?: unknown } } };
	return typeof v.kind === 'string' && typeof v.span?.start?.line === 'number';
}

function spanContains(span: Span, line: number, col: number): boolean {
	if (line < span.start.line || line > span.end.line) {
		return false;
	}
	if (line === span.start.line && col < span.start.col) {
		return false;
	}
	if (line === span.end.line && col > span.end.col) {
		return false;
	}
	return true;
}

/**
 * Collects child AST nodes of a node by walking its properties, descending
 * through arrays and plain carrier objects (Param, CaseArm, ForGenerator...).
 * `sema` is skipped: it holds checker results, not syntax.
 */
function childNodes(node: object): NodeLike[] {
	const out: NodeLike[] = [];
	const gather = (value: unknown, depth: number) => {
		if (!value || typeof value !== 'object' || depth > 3) {
			return;
		}
		if (isNodeLike(value)) {
			out.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				gather(item, depth);
			}
			return;
		}
		for (const [key, item] of Object.entries(value)) {
			if (key === 'sema' && depth > 0) {
				continue;
			}
			gather(item, depth + 1);
		}
	};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'sema' || key === 'span') {
			continue;
		}
		gather(value, 0);
	}
	return out;
}

/**
 * Path of nodes from a top-level statement down to the innermost node
 * containing the position (1-based line/col). Empty if nothing matches.
 */
export function findNodePath(program: Program, line: number, col: number): Expr[] {
	const path: NodeLike[] = [];
	let current: NodeLike | null = null;
	for (const stmt of program.body) {
		if (isNodeLike(stmt) && spanContains(stmt.span, line, col)) {
			current = stmt;
			break;
		}
	}
	while (current) {
		path.push(current);
		let next: NodeLike | null = null;
		for (const child of childNodes(current)) {
			if (spanContains(child.span, line, col)) {
				next = child;
				break;
			}
		}
		current = next;
	}
	return path as Expr[];
}

// =====================================================================
// Hover
// =====================================================================

export interface HoverInfo {
	/** Markdown; first block is a fenced `verse` signature. */
	markdown: string;
	span: Span;
}

function formatFunction(name: string, type: FuncT): string {
	const params = type.params
		.map((p) => `${p.named ? '?' : ''}${p.name} : ${typeToString(p.type)}`)
		.join(', ');
	const effects = [
		type.effects.suspends ? '<suspends>' : '',
		type.effects.decides ? '<decides>' : '',
	].filter(Boolean).join('');
	return `${name}(${params})${effects} : ${typeToString(type.ret)}`;
}

function signatureForBinding(name: string, binding: Binding): string {
	switch (binding.kind) {
		case 'local':
		case 'global':
			return `${binding.mutable ? 'var ' : ''}${name} : ${typeToString(binding.type)}`;
		case 'member':
			if (binding.isMethod && binding.type.k === 'func') {
				return formatFunction(name, binding.type);
			}
			return `${binding.mutable ? 'var ' : ''}${name} : ${typeToString(binding.type)}`;
		case 'function':
			return binding.overloads
				.map((o) => formatFunction(name, o.type))
				.join('\n');
		case 'class':
			return `${name} := ${binding.classInfo.kind}`;
		case 'enum':
			return `${name} := enum{${binding.enumInfo.values.join(', ')}}`;
		case 'module':
			return `${name} := module (${binding.module.path})`;
		case 'native': {
			const exp = binding.export;
			if (exp.kind === 'function' && exp.signatures?.length) {
				return exp.signatures.map((sig) => formatFunction(name, sig)).join('\n');
			}
			if (exp.kind === 'class') {
				return `${name} := class`;
			}
			if (exp.kind === 'enum') {
				return `${name} := enum{${exp.enumInfo?.values.join(', ') ?? ''}}`;
			}
			return `${name} : ${exp.valueType ? typeToString(exp.valueType) : 'unknown'}`;
		}
		case 'typeParam':
			return `${name} : type`;
		case 'typeAlias':
			return `${name} := ${typeToString(binding.type)}`;
	}
}

function describeBindingKind(binding: Binding): string {
	switch (binding.kind) {
		case 'local': return 'local';
		case 'global': return 'module-level definition';
		case 'function': return 'function';
		case 'member': return `member of ${binding.classInfo.name}`;
		case 'class': return binding.classInfo.kind;
		case 'enum': return 'enum';
		case 'module': return 'module';
		case 'native': return `builtin — ${binding.export.modulePath}`;
		case 'typeParam': return 'type parameter';
		case 'typeAlias': return 'type alias';
	}
}

function hoverMarkdown(signature: string, kindLine: string, doc?: string): string {
	let markdown = '```verse\n' + signature + '\n```\n*' + kindLine + '*';
	if (doc) {
		markdown += `\n\n${doc}`;
	}
	return markdown;
}

function hoverForMember(name: string, member: MemberInfo, span: Span): HoverInfo {
	const signature = member.isMethod && member.type.k === 'func'
		? formatFunction(name, member.type)
		: `${member.mutable ? 'var ' : ''}${name} : ${typeToString(member.type)}`;
	return {
		markdown: hoverMarkdown(signature, `member of ${member.origin.name}`),
		span,
	};
}

export function hoverAt(analysis: SourceAnalysis, line: number, col: number): HoverInfo | null {
	if (!analysis.program) {
		return null;
	}
	const path = findNodePath(analysis.program, line, col);
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i];
		const sema = semaOf(node);
		if (node.kind === 'Ident') {
			const binding = sema.binding;
			if (binding) {
				const doc = binding.kind === 'native' ? binding.export.doc : undefined;
				return {
					markdown: hoverMarkdown(
						signatureForBinding(node.name, binding),
						describeBindingKind(binding),
						doc,
					),
					span: node.span,
				};
			}
			if (sema.type) {
				return {
					markdown: hoverMarkdown(
						`${node.name} : ${typeToString(sema.type)}`, 'expression'),
					span: node.span,
				};
			}
		}
		if (node.kind === 'Member') {
			if (sema.memberInfo) {
				return hoverForMember(node.name, sema.memberInfo, node.span);
			}
			if (sema.memberBinding) {
				return {
					markdown: hoverMarkdown(
						signatureForBinding(node.name, sema.memberBinding),
						describeBindingKind(sema.memberBinding),
						sema.memberBinding.kind === 'native' ? sema.memberBinding.export.doc : undefined,
					),
					span: node.span,
				};
			}
			if (sema.type) {
				return {
					markdown: hoverMarkdown(
						`${node.name} : ${typeToString(sema.type)}`, 'expression'),
					span: node.span,
				};
			}
		}
		if (node.kind === 'Definition' || node.kind === 'VarDefinition' || node.kind === 'Assignment') {
			// The declared binding lives in the enclosing scope (or module
			// scope for top-level definitions), not on the node itself.
			const lookupScope = sema.scope ?? analysis.moduleScope;
			const binding = lookupScope?.lookup(node.name);
			if (binding) {
				return {
					markdown: hoverMarkdown(
						signatureForBinding(node.name, binding),
						describeBindingKind(binding),
					),
					span: node.span,
				};
			}
		}
		if (node.kind === 'FunctionDef' && sema.type?.k === 'func') {
			return {
				markdown: hoverMarkdown(formatFunction(node.name, sema.type), 'function'),
				span: node.span,
			};
		}
		if (node.kind === 'ClassDef' && sema.classInfo) {
			return {
				markdown: hoverMarkdown(`${node.name} := ${sema.classInfo.kind}`, sema.classInfo.kind),
				span: node.span,
			};
		}
		if (node.kind === 'EnumDef' && sema.enumInfo) {
			return {
				markdown: hoverMarkdown(
					`${node.name} := enum{${sema.enumInfo.values.join(', ')}}`, 'enum'),
				span: node.span,
			};
		}
	}
	return null;
}

// =====================================================================
// Go to definition
// =====================================================================

export function definitionAt(analysis: SourceAnalysis, line: number, col: number): Span | null {
	if (!analysis.program) {
		return null;
	}
	const path = findNodePath(analysis.program, line, col);
	for (let i = path.length - 1; i >= 0; i--) {
		const node = path[i];
		const sema = semaOf(node);
		if (node.kind === 'Ident' && sema.binding) {
			const binding = sema.binding;
			if (binding.declSpan) {
				return binding.declSpan;
			}
			if (binding.kind === 'function' && binding.overloads.length > 0) {
				return binding.overloads[0].fn.span;
			}
			return null;
		}
		if (node.kind === 'Member') {
			if (sema.memberInfo?.declSpan) {
				return sema.memberInfo.declSpan;
			}
			if (sema.memberBinding?.declSpan) {
				return sema.memberBinding.declSpan;
			}
			return null;
		}
	}
	return null;
}

// =====================================================================
// Completions
// =====================================================================

export interface CompletionEntry {
	name: string;
	/** Maps to Monaco CompletionItemKind in the provider. */
	kind: 'local' | 'global' | 'function' | 'member' | 'class' | 'enum'
	| 'module' | 'native' | 'typeParam' | 'typeAlias';
	detail: string;
	doc?: string;
}

function completionForBinding(name: string, binding: Binding): CompletionEntry {
	let kind: CompletionEntry['kind'] = binding.kind;
	if (binding.kind === 'native') {
		kind = binding.export.kind === 'class' ? 'class'
			: binding.export.kind === 'enum' ? 'enum'
				: binding.export.kind === 'value' ? 'global'
					: 'native';
	}
	return {
		name,
		kind,
		detail: signatureForBinding(name, binding),
		doc: binding.kind === 'native' ? binding.export.doc : undefined,
	};
}

/**
 * All names visible at the position, innermost scope first (shadowing
 * respected). Falls back to module scope when the position isn't inside
 * any checked expression (e.g. blank line at top level).
 */
export function completionsAt(analysis: SourceAnalysis, line: number, col: number): CompletionEntry[] {
	if (!analysis.program) {
		return [];
	}
	const path = findNodePath(analysis.program, line, col);
	let scope: Scope | null = null;
	for (let i = path.length - 1; i >= 0; i--) {
		const sema = semaOf(path[i]);
		if (sema.scope) {
			scope = sema.scope;
			break;
		}
	}
	scope = scope ?? analysis.moduleScope;

	const seen = new Set<string>();
	const entries: CompletionEntry[] = [];
	while (scope) {
		for (const [name, binding] of scope.bindings) {
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			entries.push(completionForBinding(name, binding));
		}
		scope = scope.parent;
	}
	return entries;
}
