// printer.ts
// Compact S-expression-style AST printer for tests and debugging.

import { Expr, Program } from './ast';

export function printProgram(program: Program): string {
	return program.body.map((e) => printExpr(e)).join('\n');
}

export function printExpr(e: Expr): string {
	switch (e.kind) {
		case 'IntLit': return String(e.value);
		case 'FloatLit': return e.value.toFixed(e.value % 1 === 0 ? 1 : undefined);
		case 'CharLit': return `'${e.value}'`;
		case 'LogicLit': return String(e.value);
		case 'StringLit':
			return `(str ${e.parts.map((p) => (typeof p === 'string' ? JSON.stringify(p) : printExpr(p))).join(' ')})`;
		case 'Ident': return e.name;
		case 'SelfExpr': return 'Self';
		case 'Placeholder': return '_';
		case 'Interpolant': return printExpr(e.expr);
		case 'Block': return `(${e.label} ${e.exprs.map(printExpr).join(' ')})`;
		case 'Tuple': return `(tuple ${e.elements.map(printExpr).join(' ')})`;
		case 'ArrayLit': return `(array ${e.elements.map(printExpr).join(' ')})`;
		case 'MapLit': return `(map ${e.entries.map((en) => `${printExpr(en.key)}=>${printExpr(en.value)}`).join(' ')})`;
		case 'OptionLit': return e.value ? `(option ${printExpr(e.value)})` : '(option)';
		case 'RangeExpr': return `(range ${printExpr(e.low)} ${printExpr(e.high)})`;
		case 'TypeLit': return `(type ${e.raw})`;
		case 'Unary': return `(${e.op} ${printExpr(e.operand)})`;
		case 'Binary': return `(${e.op} ${printExpr(e.left)} ${printExpr(e.right)})`;
		case 'AndExpr': return `(and ${printExpr(e.left)} ${printExpr(e.right)})`;
		case 'OrExpr': return `(or ${printExpr(e.left)} ${printExpr(e.right)})`;
		case 'NotExpr': return `(not ${printExpr(e.operand)})`;
		case 'QueryExpr': return `(? ${printExpr(e.operand)})`;
		case 'Call':
			return `(${e.failable ? 'call[]' : 'call'} ${printExpr(e.callee)}${e.args.map((a) => ' ' + (a.name ? `?${a.name}:=` : '') + printExpr(a.value)).join('')})`;
		case 'Index': return `(index ${printExpr(e.target)} ${printExpr(e.index)})`;
		case 'Member': return `(. ${printExpr(e.target)} ${e.name})`;
		case 'Archetype':
			return `(new ${printExpr(e.callee)}${e.fields.map((f) => ` ${f.name}:=${printExpr(f.value)}`).join('')}${e.body.map((b) => ' ' + printExpr(b)).join('')})`;
		case 'Definition':
			return `(def ${e.name}${e.type ? ` : ${printExpr(e.type)}` : ''}${e.value ? ` = ${printExpr(e.value)}` : ''})`;
		case 'VarDefinition':
			return `(var ${e.name}${e.type ? ` : ${printExpr(e.type)}` : ''}${e.value ? ` = ${printExpr(e.value)}` : ''})`;
		case 'SetExpr': return `(set ${printExpr(e.target)} ${e.op} ${printExpr(e.value)})`;
		case 'Assignment': return `(bind ${e.name} ${printExpr(e.value)})`;
		case 'FunctionDef':
			return `(fn ${e.name}(${e.params.map((p) => `${p.named ? '?' : ''}${p.name}${p.type ? `:${printExpr(p.type)}` : ''}`).join(', ')})${e.effects.map((s) => `<${s.name}>`).join('')}${e.returnType ? ` : ${printExpr(e.returnType)}` : ''}${e.body ? ` = ${printExpr(e.body)}` : ''})`;
		case 'ClassDef':
			return `(${e.classKind} ${e.name}${e.supers.length ? `(${e.supers.map(printExpr).join(', ')})` : ''} ${e.members.map(printExpr).join(' ')})`;
		case 'ModuleDef': return `(module ${e.name} ${e.members.map(printExpr).join(' ')})`;
		case 'EnumDef': return `(enum ${e.name} ${e.values.map((v) => v.name).join(' ')})`;
		case 'TypeAliasDef': return `(alias ${e.name} ${printExpr(e.value)})`;
		case 'UsingDecl': return `(using ${e.path})`;
		case 'IfExpr':
			return `(if ${e.clauses.map((c) => `[${c.conditions.map(printExpr).join(', ')} -> ${printExpr(c.body)}]`).join(' ')}${e.elseBody ? ` else ${printExpr(e.elseBody)}` : ''})`;
		case 'CaseExpr':
			return `(case ${printExpr(e.subject)} ${e.arms.map((a) => `[${a.pattern ? printExpr(a.pattern) : '_'} => ${printExpr(a.body)}]`).join(' ')})`;
		case 'ForExpr':
			return `(for ${e.generators.map((g) => `${g.name}${g.valueName ? `->${g.valueName}` : ''}:${printExpr(g.iterable)}`).join(', ')}${e.filters.length ? ` if ${e.filters.map(printExpr).join(', ')}` : ''} ${printExpr(e.body)})`;
		case 'LoopExpr': return `(loop ${printExpr(e.body)})`;
		case 'WhileExpr': return `(while ${printExpr(e.condition)} ${printExpr(e.body)})`;
		case 'BreakExpr': return '(break)';
		case 'ReturnExpr': return e.value ? `(return ${printExpr(e.value)})` : '(return)';
		case 'DeferExpr': return `(defer ${printExpr(e.body)})`;
		case 'SpawnExpr': return `(spawn ${printExpr(e.body)})`;
		case 'ConcurrencyBlock': return `(${e.op} ${e.clauses.map(printExpr).join(' ')})`;
		case 'OptionType': return `?${printExpr(e.inner)}`;
		case 'ArrayType': return `[]${printExpr(e.element)}`;
		case 'MapType': return `[${printExpr(e.key)}]${printExpr(e.value)}`;
		case 'TupleType': return `tuple(${e.elements.map(printExpr).join(', ')})`;
		case 'FunctionType': return `(${e.params.map(printExpr).join(', ')}) -> ${printExpr(e.result)}`;
		case 'GenericType': return `${printExpr(e.base)}(${e.args.map(printExpr).join(', ')})`;
		case 'FailureExpr': return `(reserved ${e.keyword})`;
		case 'ProfileExpr': return `(profile ${printExpr(e.body)})`;
	}
}
