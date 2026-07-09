// analysis-engine.ts
// The IDE's semantic-analysis engine: holds the current workspace sources,
// lazily compiles them through a host, and answers position queries with
// plain serializable results (no AST/scope objects escape). It runs inside
// the analysis Web Worker (analysis.worker.ts) so per-keystroke checking
// never blocks the UI thread; analysis-client.ts also instantiates it
// directly as a same-thread fallback when workers are unavailable.

import type { VerseHost, IdeDiagnostic } from '../verse';
import {
	completionsAt, definitionAt, hoverAt,
} from '../verse/analysis';
import type {
	CompletionEntry, DefinitionLocation, HoverInfo,
	SourceAnalysis, WorkspaceAnalysis,
} from '../verse/analysis';

export class AnalysisEngine {
	private readonly host: VerseHost;
	private files: Record<string, string> = {};
	private version = 0;
	// The workspace is re-analyzed only when a query arrives after the
	// sources changed, so rapid setFiles calls while typing cost nothing.
	private cache: { version: number; analysis: WorkspaceAnalysis } | null = null;
	// Per-file last-good analyses keep hover/completions working while the
	// user is mid-edit with a syntax error somewhere in the workspace.
	private readonly lastGoodByFile = new Map<string, SourceAnalysis>();

	constructor(host: VerseHost) {
		this.host = host;
	}

	setFiles(files: Record<string, string>): void {
		this.files = files;
		this.version += 1;
	}

	private analysis(): WorkspaceAnalysis {
		if (this.cache && this.cache.version === this.version) {
			return this.cache.analysis;
		}
		let analysis: WorkspaceAnalysis;
		try {
			analysis = this.host.analyzeWorkspace(this.files);
		} catch {
			analysis = { ok: false, files: new Map(), diagnostics: [] };
		}
		this.cache = { version: this.version, analysis };
		if (analysis.ok) {
			for (const [file, fileAnalysis] of analysis.files) {
				this.lastGoodByFile.set(file, fileAnalysis);
			}
		}
		return analysis;
	}

	private fileAnalysis(file: string): SourceAnalysis | null {
		return this.analysis().files.get(file) ?? this.lastGoodByFile.get(file) ?? null;
	}

	diagnostics(): IdeDiagnostic[] {
		return this.analysis().diagnostics;
	}

	hover(file: string, line: number, col: number): HoverInfo | null {
		const analysis = this.fileAnalysis(file);
		return analysis ? hoverAt(analysis, line, col) : null;
	}

	definition(file: string, line: number, col: number): DefinitionLocation | null {
		const analysis = this.fileAnalysis(file);
		return analysis ? definitionAt(analysis, line, col) : null;
	}

	completions(file: string, line: number, col: number): CompletionEntry[] {
		const analysis = this.fileAnalysis(file);
		return analysis ? completionsAt(analysis, line, col) : [];
	}
}

/** Engine methods callable through the worker protocol. */
export type AnalysisMethod = 'setFiles' | 'diagnostics' | 'hover' | 'definition' | 'completions';

export interface AnalysisRequest {
	/** Absent for fire-and-forget calls (setFiles). */
	id?: number;
	method: AnalysisMethod;
	args: unknown[];
}

export type AnalysisResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: string };

/** Dispatches one protocol request against an engine (shared by the worker
 * and the same-thread fallback so both paths behave identically). */
export function dispatchAnalysisRequest(engine: AnalysisEngine, request: AnalysisRequest): unknown {
	const args = request.args;
	switch (request.method) {
		case 'setFiles':
			engine.setFiles(args[0] as Record<string, string>);
			return undefined;
		case 'diagnostics':
			return engine.diagnostics();
		case 'hover':
			return engine.hover(args[0] as string, args[1] as number, args[2] as number);
		case 'definition':
			return engine.definition(args[0] as string, args[1] as number, args[2] as number);
		case 'completions':
			return engine.completions(args[0] as string, args[1] as number, args[2] as number);
	}
}
