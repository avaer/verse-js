// compile.js
// Front half of the pipeline: preprocess (indentation -> `end`), parse
// (Peggy), and semantic analysis. Returns either an AST ready for the
// interpreter or a structured diagnostic with original-source coordinates.

import { parse } from './parser.js';
import { injectEndsWithMap, mapToOriginalLine } from './preprocess.js';
import { analyzeProgram, SemanticError } from './semanticAnalysis.js';

// Compiles Verse source. Returns:
//   { ok: true, ast, lineMap }
//   { ok: false, diagnostic: { message, severity, startLine, startColumn, endLine, endColumn } }
export function compileVerse(sourceCode, options = {}) {
	const { skipSemanticAnalysis = false } = options;
	const { code, lineMap } = injectEndsWithMap(sourceCode);

	let ast;
	try {
		ast = parse(code);
	} catch (error) {
		return {
			ok: false,
			diagnostic: syntaxErrorToDiagnostic(error, lineMap),
		};
	}

	if (!skipSemanticAnalysis) {
		try {
			analyzeProgram(ast);
		} catch (error) {
			if (error instanceof SemanticError) {
				return {
					ok: false,
					diagnostic: semanticErrorToDiagnostic(error, lineMap),
				};
			}
			throw error;
		}
	}

	return { ok: true, ast, lineMap };
}

function syntaxErrorToDiagnostic(error, lineMap) {
	const loc = error.location || null;
	const startLine = loc ? mapToOriginalLine(lineMap, loc.start.line) : 1;
	const endLine = loc ? mapToOriginalLine(lineMap, loc.end.line) : startLine;
	return {
		message: `Syntax error: ${error.message}`,
		severity: 'error',
		startLine,
		startColumn: loc ? loc.start.column : 1,
		endLine: Math.max(startLine, endLine),
		endColumn: loc ? Math.max(loc.end.column, (loc.start.column || 1) + 1) : 200,
	};
}

function semanticErrorToDiagnostic(error, lineMap) {
	const loc = error.loc || null;
	const startLine = loc ? mapToOriginalLine(lineMap, loc.start.line) : 1;
	return {
		message: error.message,
		severity: 'error',
		code: error.code,
		startLine,
		startColumn: loc ? loc.start.column : 1,
		endLine: startLine,
		endColumn: 200,
	};
}
