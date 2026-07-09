// interpreter.js
// Tree-walking interpreter for the Verse subset. Executes the AST produced by
// the Peggy parser (src/verse/parser.js).
//
// Vendorized from johanfortus/Verse-Online-Editor (MIT) and substantially
// reworked for the IDE:
//   - fully async: statements are awaitable, so `suspends` natives like Sleep
//     map onto JS promises, and infinite loops stay interruptible
//   - streaming output: Print routes through an onOutput sink (the console
//     panel) as it happens, in addition to the accumulated output string
//   - debug hooks: before every statement the interpreter yields to an
//     execution controller that implements breakpoints, stepping, pause and
//     cancellation
//   - failure-context rollback: `if (...)` conditions and the left operand of
//     `or` open a transaction; writes inside them are journaled and rolled
//     back when the context fails (mirrors VerseVM's failure contexts)

import { getImportedRuntimeBindings, getImportedSymbols, resolveImportPaths } from './runtime/libraries.js';
import { Transaction, VerseFailure, VerseRunCancelled } from './runtime/failure.js';

export class VerseInterpreter {
	constructor(options = {}) {
		this.onOutput = options.onOutput || null;
		this.controller = options.controller || null;
		this.output = '';
		this.symbolTable = new Map();
		this.nativeFunctionTable = new Map();
		this.breakEncountered = false;
		this.functionTable = new Map();
		this.currentMethodTable = null;
		this.returnValue = null;
		this.returnEncountered = false;
		this.lastExpressionValue = null;
		this.transactionStack = [];
		this.callDepth = 0;
		this.callStack = [];
		this.currentStatement = null;
	}

	async interpret(ast) {
		this.output = '';
		this.symbolTable = new Map();
		this.nativeFunctionTable = new Map();
		this.functionTable = new Map();
		this.currentMethodTable = null;
		this.returnValue = null;
		this.returnEncountered = false;
		this.lastExpressionValue = null;
		this.transactionStack = [];
		this.callDepth = 0;
		this.callStack = [];

		if (!ast || typeof ast !== 'object' || !Array.isArray(ast.body)) {
			throw new Error('Invalid AST structure: Expected an object with a body array');
		}

		this.loadImportedLibraries(ast);
		await this.registerProgram(ast);
		await this.runDeviceEntrypoints();
		return this.output;
	}

	emit(text) {
		this.output += text + '\n';
		if (this.onOutput) {
			this.onOutput(text);
		}
	}

	loadImportedLibraries(program) {
		const importPaths = resolveImportPaths(program.body
			.filter(statement => statement.type === 'UsingDeclaration')
			.map(statement => statement.path));
		const importedSymbols = getImportedSymbols(importPaths);
		const runtimeBindings = getImportedRuntimeBindings(importPaths);

		for (const [symbolName, symbol] of importedSymbols.entries()) {
			if (symbol.type !== 'NativeFunction') {
				this.symbolTable.set(symbolName, symbol);
			}
		}

		for (const [symbolName, nativeFunction] of runtimeBindings.nativeFunctions.entries()) {
			this.nativeFunctionTable.set(symbolName, nativeFunction);
		}
	}

	async registerProgram(program) {
		for (const statement of program.body) {
			if (this.isDeclarationStatement(statement)) {
				await this.visitStatement(statement);
			}
		}
	}

	isDeclarationStatement(statement) {
		return [
			'FunctionDeclaration',
			'VariableDeclaration',
			'ConstDeclaration',
			'ClassDefinition',
		].includes(statement.type);
	}

	async runDeviceEntrypoints() {
		for (const symbol of [...this.symbolTable.values()]) {
			if (symbol.type !== 'ClassSymbol' || symbol.parent !== 'creative_device') {
				continue;
			}

			const onBeginMethod = symbol.members.find(member =>
				member.type === 'FunctionDeclaration' && member.name.name === 'OnBegin'
			);

			if (!onBeginMethod) {
				continue;
			}

			const methodTable = new Map(
				symbol.members
					.filter(member => member.type === 'FunctionDeclaration')
					.map(member => [member.name.name, member])
			);

			const instanceScope = await this.buildClassInstanceScope(symbol, methodTable);
			await this.invokeStoredFunction(onBeginMethod, [], methodTable, instanceScope);
		}
	}

	async buildClassInstanceScope(classSymbol, methodTable) {
		const originalSymbolTable = this.symbolTable;
		const originalMethodTable = this.currentMethodTable;
		const instanceScope = new Map(this.symbolTable);

		this.symbolTable = instanceScope;
		this.currentMethodTable = methodTable;

		try {
			for (const member of classSymbol.members) {
				if (member.type === 'VariableDeclaration' || member.type === 'ConstDeclaration') {
					await this.visitStatement(member);
				}
			}

			return new Map(this.symbolTable);
		} finally {
			this.symbolTable = originalSymbolTable;
			this.currentMethodTable = originalMethodTable;
		}
	}

	// --- transactional writes (failure-context rollback) ---

	currentTransaction() {
		return this.transactionStack.length > 0
			? this.transactionStack[this.transactionStack.length - 1]
			: null;
	}

	writeSymbol(name, entry) {
		const transaction = this.currentTransaction();
		if (transaction) {
			transaction.recordSymbolWrite(this.symbolTable, name);
		}
		this.symbolTable.set(name, entry);
	}

	writeArrayElement(array, index, value) {
		const transaction = this.currentTransaction();
		if (transaction) {
			transaction.recordElementWrite(array, index);
		}
		array[index] = value;
	}

	// Evaluates `evaluate()` inside a new failure context. If it fails with
	// VerseFailure, all journaled writes are rolled back and `onFailure()` is
	// used to produce the result instead.
	async runInFailureContext(evaluate, onFailure) {
		const transaction = new Transaction();
		this.transactionStack.push(transaction);

		let result;
		try {
			result = await evaluate();
		} catch (error) {
			this.transactionStack.pop();
			if (!(error instanceof VerseFailure)) {
				throw error;
			}
			transaction.rollback();
			return onFailure(error);
		}

		this.transactionStack.pop();
		transaction.commitInto(this.currentTransaction());
		return result;
	}

	// --- statement execution ---

	async visitStatement(statement) {
		this.currentStatement = statement;
		if (this.controller) {
			await this.controller.onStatement(statement, this);
		}

		switch (statement.type) {
			case 'FunctionDeclaration':
				this.visitFunctionDeclaration(statement);
				break;
			case 'VariableDeclaration':
				await this.visitVariableDeclaration(statement);
				break;
			case 'ConstDeclaration':
				await this.visitConstDeclaration(statement);
				break;
			case 'ClassDefinition':
				this.visitClassDefinition(statement);
				break;
			case 'SetStatement':
				await this.visitSetStatement(statement);
				break;
			case 'PrintStatement':
				await this.visitPrintStatement(statement);
				break;
			case 'IfStatement':
				await this.visitIfStatement(statement);
				break;
			case 'LoopStatement':
				await this.visitLoopStatement(statement);
				break;
			case 'ForStatement':
				await this.visitForStatement(statement);
				break;
			case 'BreakStatement':
				this.visitBreakStatement();
				break;
			case 'ReturnStatement':
				await this.visitReturnStatement(statement);
				break;
			case 'FunctionCallStatement':
				await this.visitFunctionCallStatement(statement);
				break;
			case 'ExpressionStatement':
				await this.visitExpressionStatement(statement);
				break;
			default:
				throw new Error(`Unsupported statement type: ${statement.type}`);
		}
	}

	visitBreakStatement() {
		this.breakEncountered = true;
	}

	async visitVariableDeclaration(declaration) {
		const varName = declaration.name.name;
		if (this.symbolTable.has(varName)) {
			throw new Error(`Variable '${varName}' is already declared`);
		}

		const value = await this.evaluateExpression(declaration.value);
		this.writeSymbol(varName, { type: declaration.varType.name, value, isConstant: false });
	}

	async visitConstDeclaration(declaration) {
		const constName = declaration.name.name;
		if (this.symbolTable.has(constName)) {
			throw new Error(`Variable '${constName}' is already declared`);
		}
		const value = await this.evaluateExpression(declaration.value);
		let resolvedType;
		if (declaration.constType && declaration.constType.name) {
			resolvedType = declaration.constType.name;
		}
		else {
			resolvedType = this.inferVerseTypeFromValue(value);
		}
		this.writeSymbol(constName, { type: resolvedType, value, isConstant: true });
	}

	visitClassDefinition(classDefinition) {
		const className = classDefinition.name.name;
		const parentClassName = classDefinition.parentClass.name;
		const parentClass = this.symbolTable.get(parentClassName);

		if (!parentClass || (parentClass.type !== 'NativeClass' && parentClass.type !== 'ClassSymbol')) {
			throw new Error(`Unknown parent class: ${parentClassName}`);
		}

		if (this.symbolTable.has(className)) {
			throw new Error(`Variable '${className}' is already declared`);
		}

		this.symbolTable.set(className, {
			type: 'ClassSymbol',
			name: className,
			parent: parentClassName,
			members: classDefinition.members,
		});
	}

	inferVerseTypeFromValue(value) {
		if (Array.isArray(value)) {
			return 'array';
		}
		switch (typeof value) {
			case 'number':
				return Number.isInteger(value) ? 'int' : 'float';
			case 'string':
				return 'string';
			case 'boolean':
				return 'logic';
			default:
				return 'dynamic';
		}
	}

	async visitPrintStatement(printStatement) {
		try {
			const value = printStatement.value.type === 'InterpolatedString'
				? await this.evaluateInterpolatedString(printStatement.value)
				: String(await this.evaluateExpression(printStatement.value));
			this.emit(value);
		}
		catch (error) {
			if (error instanceof VerseRunCancelled) {
				throw error;
			}
			this.emit(`Error: ${error.message}`);
		}
	}

	async visitIfStatement(ifStatement) {
		const condition = await this.runInFailureContext(
			() => this.evaluateExpression(ifStatement.condition),
			() => false,
		);

		if (condition !== null && condition) {
			for (const statement of ifStatement.body) {
				await this.visitStatement(statement);
				if (this.breakEncountered || this.returnEncountered) {
					break;
				}
			}
		}
		else {
			for (const statement of ifStatement.elseBody || []) {
				await this.visitStatement(statement);
				if (this.breakEncountered || this.returnEncountered) {
					break;
				}
			}
		}
	}

	async visitExpressionStatement(expressionStatement) {
		this.lastExpressionValue = await this.evaluateExpression(expressionStatement.expression);
		return this.lastExpressionValue;
	}

	async runIterationBody(statements) {
		const scopeKeysBefore = new Set(this.symbolTable.keys());
		try {
			for (const statement of statements) {
				await this.visitStatement(statement);
				if (this.breakEncountered || this.returnEncountered) {
					break;
				}
			}
		}
		finally {
			for (const key of this.symbolTable.keys()) {
				if (!scopeKeysBefore.has(key)) {
					this.symbolTable.delete(key);
				}
			}
		}
	}

	async visitLoopStatement(loopStatement) {
		while (true) {
			await this.runIterationBody(loopStatement.body);
			if (this.returnEncountered) {
				return;
			}
			if (this.breakEncountered) {
				this.breakEncountered = false;
				return;
			}
		}
	}

	async visitForStatement(forStatement) {
		const start = await this.evaluateExpression(forStatement.range.start);
		const end = await this.evaluateExpression(forStatement.range.end);

		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error('Range values must be integers');
		}

		const varType = forStatement.varType ? forStatement.varType.name : 'int';

		for (let i = start; i <= end; i++) {
			this.symbolTable.set(forStatement.variable.name, { type: varType, value: i });
			await this.runIterationBody(forStatement.body);
			if (this.returnEncountered) {
				this.symbolTable.delete(forStatement.variable.name);
				return;
			}
			if (this.breakEncountered) {
				this.breakEncountered = false;
				this.symbolTable.delete(forStatement.variable.name);
				return;
			}
		}
		this.symbolTable.delete(forStatement.variable.name);
	}

	async visitArrayLiteral(arrayLiteral) {
		const elements = [];
		for (const element of arrayLiteral.elements) {
			elements.push(await this.evaluateExpression(element));
		}
		return elements;
	}

	async visitArrayAccess(arrayAccess) {
		const array = this.symbolTable.get(arrayAccess.array.name);
		if (!array || !Array.isArray(array.value)) {
			return null;
		}
		const index = await this.evaluateExpression(arrayAccess.index);
		if (index < 0 || index >= array.value.length) {
			return null;
		}
		return array.value[index];
	}

	async visitSetStatement(setStatement) {
		if (setStatement.name.type === 'ArrayAccess') {
			const arrayAccess = setStatement.name;
			const array = this.symbolTable.get(arrayAccess.array.name);

			if (!array || !Array.isArray(array.value)) {
				throw new Error(`Array ${arrayAccess.array.name} not found or not an array`);
			}

			const index = await this.evaluateExpression(arrayAccess.index);
			if (index < 0 || index >= array.value.length) {
				throw new VerseFailure(`Index out of bounds: ${index}`);
			}

			const newValue = await this.evaluateExpression(setStatement.value);
			if (array.isConstant) {
				throw new Error(`Cannot modify constant '${arrayAccess.array.name}'`);
			}
			this.writeArrayElement(array.value, index, newValue);
		}
		else {
			const value = await this.evaluateExpression(setStatement.value);
			const varName = setStatement.name.name;
			if (this.symbolTable.has(varName)) {
				const entry = this.symbolTable.get(varName);
				if (entry.isConstant) {
					throw new Error(`Cannot reassign constant '${varName}'`);
				}
				let newValue;
				switch (setStatement.operator) {
					case '=':
						newValue = value;
						break;
					case '+=': {
						newValue = entry.value + value;
						break;
					}
					case '-=': {
						newValue = entry.value - value;
						break;
					}
					case '*=': {
						newValue = entry.value * value;
						break;
					}
					case '/=': {
						newValue = entry.value / value;
						break;
					}
					default:
						throw new Error(`Unsupported assignment operator: ${setStatement.operator}`);
				}
				this.writeSymbol(varName, { ...entry, value: newValue });
			}
			else {
				throw new Error(`Cannot set undeclared variable: ${varName}`);
			}
		}
	}

	async evaluateInterpolatedString(interpolatedString) {
		const parts = [];
		for (const part of interpolatedString.parts) {
			if (part.type === 'TextPart') {
				parts.push(part.text);
			}
			else if (part.type === 'InterpolatedExpression') {
				try {
					parts.push(String(await this.evaluateExpression(part.expression)));
				}
				catch (error) {
					if (error instanceof VerseRunCancelled) {
						throw error;
					}
					parts.push(`<${error.message}>`);
				}
			}
		}
		return parts.join('');
	}

	async evaluateExpression(expression) {
		switch (expression.type) {
			case 'StringLiteral':
			case 'IntegerLiteral':
			case 'FloatLiteral':
				return expression.value;
			case 'BooleanLiteral':
				return expression.value;
			case 'ArrayLiteral':
				return await this.visitArrayLiteral(expression);
			case 'Identifier':
				if (this.symbolTable.has(expression.name)) {
					return this.symbolTable.get(expression.name).value;
				}
				throw new Error(`Undefined variable: ${expression.name}`);
			case 'ArrayLength': {
				const array = await this.evaluateExpression(expression.array);
				if (!Array.isArray(array)) {
					throw new Error(`Cannot get .Length of a non-array value`);
				}
				return array.length;
			}
			case 'ArrayAccess':
				return await this.visitArrayAccess(expression);
			case 'BinaryExpression':
				return await this.evaluateBinaryExpression(expression);
			case 'UnaryExpression':
				return await this.evaluateUnaryExpression(expression);
			case 'AssignmentExpression': {
				const value = await this.evaluateExpression(expression.value);
				this.writeSymbol(expression.variable.name, { type: 'dynamic', value });
				return value;
			}
			case 'Range': {
				const start = await this.evaluateExpression(expression.start);
				const end = await this.evaluateExpression(expression.end);
				return { type: 'Range', start, end };
			}
			case 'FunctionCall':
				return await this.visitFunctionCall(expression);
			case 'InterpolatedString':
				return await this.evaluateInterpolatedString(expression);
			default:
				throw new Error(`Unsupported expression type: ${expression.type}`);
		}
	}

	async evaluateBinaryExpression(expression) {
		if (expression.operator === 'or') {
			// The left operand of `or` is a failure context: if it fails, its
			// writes roll back and the right operand is evaluated instead.
			const left = await this.runInFailureContext(
				() => this.evaluateExpression(expression.left),
				() => undefined,
			);
			if (left === undefined) {
				return await this.evaluateExpression(expression.right);
			}
			return left ? left : await this.evaluateExpression(expression.right);
		}

		const left = await this.evaluateExpression(expression.left);
		const right = await this.evaluateExpression(expression.right);
		switch (expression.operator) {
			case '+': return left + right;
			case '-': return left - right;
			case '*': return left * right;
			case '/':
				if (expression.isIntegerDivision && right === 0) {
					throw new VerseFailure(`Division by zero: ${left} / ${right}`);
				}
				return left / right;
			case '>': return left > right;
			case '<': return left < right;
			case '>=': return left >= right;
			case '<=': return left <= right;
			case '=': return left === right;
			case 'and': return left && right;
			default:
				throw new Error(`Unsupported binary operator: ${expression.operator}`);
		}
	}

	async evaluateUnaryExpression(expression) {
		const operand = await this.evaluateExpression(expression.expression);
		switch (expression.operator) {
			case 'not': return !operand;
			case '?': return !!operand;
			default:
				throw new Error(`Unsupported unary operator: ${expression.operator}`);
		}
	}

	visitFunctionDeclaration(functionDeclaration) {
		const functionName = functionDeclaration.name.name;

		this.functionTable.set(functionName, {
			name: functionDeclaration.name,
			parameters: functionDeclaration.parameters,
			returnType: functionDeclaration.returnType,
			body: functionDeclaration.body,
			effects: functionDeclaration.effects || [],
		});
	}

	async visitFunctionCall(functionCall) {
		const functionName = functionCall.name.name;

		// Evaluate arguments once so bracket syntax can resolve to either
		// function calls or array indexing based on the symbol type at runtime.
		const args = [];
		for (const arg of functionCall.arguments) {
			args.push(await this.evaluateExpression(arg));
		}

		if (!this.functionTable.has(functionName)) {
			if (this.nativeFunctionTable.has(functionName)) {
				const nativeFunction = this.nativeFunctionTable.get(functionName);
				if (args.length !== nativeFunction.parameters.length) {
					throw new Error(
						`Function '${functionName}' expects ${nativeFunction.parameters.length} arguments, but ${args.length} were provided`
					);
				}

				const result = nativeFunction.invoke(...args);
				// Race `suspends` natives (Sleep) against Stop so cancellation
				// interrupts a sleeping coroutine immediately.
				if (result && typeof result.then === 'function' && this.controller?.raceCancellation) {
					return await this.controller.raceCancellation(result);
				}
				return await result;
			}

			if (this.currentMethodTable?.has(functionName)) {
				const methodDef = this.currentMethodTable.get(functionName);
				return await this.invokeStoredFunction(methodDef, args, this.currentMethodTable, this.symbolTable, functionCall);
			}

			const symbol = this.symbolTable.get(functionName);
			if (symbol && Array.isArray(symbol.value)) {
				if (args.length !== 1) {
					throw new Error(`Array '${functionName}' expects exactly one index, but ${args.length} were provided`);
				}

				const index = args[0];
				if (!Number.isInteger(index)) {
					throw new Error(`Array index for '${functionName}' must be an integer`);
				}
				if (index < 0 || index >= symbol.value.length) {
					throw new VerseFailure(`Index out of bounds: ${index}`);
				}

				return symbol.value[index];
			}

			throw new Error(`Function '${functionName}' is not defined`);
		}

		const functionDef = this.functionTable.get(functionName);

		return await this.invokeStoredFunction(functionDef, args, this.currentMethodTable, this.symbolTable, functionCall);
	}

	async invokeStoredFunction(functionDef, args, methodTable = this.currentMethodTable, baseScope = this.symbolTable, callSite = null) {
		const functionName = functionDef.name.name;

		if (args.length !== functionDef.parameters.length) {
			throw new Error(`Function '${functionName}' expects ${functionDef.parameters.length} arguments, but ${args.length} were provided`);
		}

		const originalSymbolTable = this.symbolTable;
		this.returnEncountered = false;
		this.returnValue = null;
		const originalLastExpressionValue = this.lastExpressionValue;
		const originalMethodTable = this.currentMethodTable;
		this.lastExpressionValue = null;
		this.currentMethodTable = methodTable;
		this.symbolTable = new Map(baseScope);
		this.callDepth += 1;
		this.callStack.push({
			name: functionName,
			line: callSite?.loc?.start?.line ?? functionDef.body?.[0]?.loc?.start?.line ?? null,
		});

		try {
			for (let i = 0; i < functionDef.parameters.length; i++) {
				const param = functionDef.parameters[i];
				const argValue = args[i];
				const paramType = param.paramType.name;

				this.symbolTable.set(param.name.name, {
					type: paramType,
					value: argValue,
					isConstant: true
				});
			}

			for (const statement of functionDef.body) {
				await this.visitStatement(statement);
				if (this.returnEncountered) {
					break;
				}
			}

			if (this.returnEncountered) {
				return this.returnValue;
			}

			if ((functionDef.effects || []).includes('decides')) {
				if (!this.lastExpressionValue) {
					throw new VerseFailure(`${functionName} failed`);
				}
				return this.lastExpressionValue;
			}

			return this.lastExpressionValue;
		} finally {
			this.symbolTable = originalSymbolTable;
			this.returnEncountered = false;
			this.returnValue = null;
			this.lastExpressionValue = originalLastExpressionValue;
			this.currentMethodTable = originalMethodTable;
			this.callDepth -= 1;
			this.callStack.pop();
		}
	}

	async visitReturnStatement(returnStatement) {
		this.returnEncountered = true;
		if (returnStatement.value) {
			this.returnValue = await this.evaluateExpression(returnStatement.value);
		} else {
			this.returnValue = null;
		}
	}

	async visitFunctionCallStatement(functionCallStatement) {
		await this.visitFunctionCall(functionCallStatement.functionCall);
	}

	// Snapshot of user-visible variables for the debugger's variables panel.
	getScopeSnapshot() {
		const variables = [];
		for (const [name, entry] of this.symbolTable.entries()) {
			if (!entry || typeof entry !== 'object' || !('value' in entry)) {
				continue;
			}
			if (['ClassSymbol', 'NativeClass', 'NativeFunction'].includes(entry.type)) {
				continue;
			}
			variables.push({
				name,
				type: Array.isArray(entry.value) ? 'array' : entry.type,
				value: formatVerseValue(entry.value),
				isConstant: !!entry.isConstant,
			});
		}
		return variables;
	}

	getCallStackSnapshot() {
		return [...this.callStack].reverse();
	}
}

export function formatVerseValue(value) {
	if (Array.isArray(value)) {
		return `array{${value.map(formatVerseValue).join(', ')}}`;
	}
	if (typeof value === 'string') {
		return `"${value}"`;
	}
	return String(value);
}
