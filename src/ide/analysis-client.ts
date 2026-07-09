// analysis-client.ts
// Main-thread handle to the IDE's semantic analysis. Prefers running the
// AnalysisEngine inside a Web Worker (analysis.worker.ts) so workspace
// compiles never block typing; when workers are unavailable (SSR, tests)
// or the worker crashes, it degrades to running the same engine
// synchronously on this thread. All queries are promise-based either way.

import type { IdeDiagnostic } from '../verse';
import type {
	CompletionEntry, DefinitionLocation, HoverInfo,
} from '../verse/analysis';
import {
	AnalysisEngine, AnalysisRequest, AnalysisResponse, dispatchAnalysisRequest,
} from './analysis-engine';
import { ideHost } from './verse-host';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class AnalysisClient {
	private worker: Worker | null = null;
	private workerFailed = false;
	private fallback: AnalysisEngine | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	// Kept so a worker that crashes mid-session can be replaced by the
	// fallback engine without losing the current sources.
	private files: Record<string, string> = {};

	private getWorker(): Worker | null {
		if (this.workerFailed || typeof Worker === 'undefined' || typeof window === 'undefined') {
			return null;
		}
		if (!this.worker) {
			try {
				this.worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
			} catch {
				this.workerFailed = true;
				return null;
			}
			this.worker.onmessage = (event: MessageEvent<AnalysisResponse>) => {
				const response = event.data;
				const entry = this.pending.get(response.id);
				if (!entry) {
					return;
				}
				this.pending.delete(response.id);
				if (response.ok) {
					entry.resolve(response.result);
				} else {
					entry.reject(new Error(response.error));
				}
			};
			this.worker.onerror = () => {
				// Worker failed to load or crashed: reject in-flight queries
				// and route everything to the same-thread engine from now on.
				this.workerFailed = true;
				this.worker?.terminate();
				this.worker = null;
				for (const entry of this.pending.values()) {
					entry.reject(new Error('analysis worker failed'));
				}
				this.pending.clear();
				this.getFallback().setFiles(this.files);
			};
		}
		return this.worker;
	}

	private getFallback(): AnalysisEngine {
		if (!this.fallback) {
			this.fallback = new AnalysisEngine(ideHost);
			this.fallback.setFiles(this.files);
		}
		return this.fallback;
	}

	private request(method: AnalysisRequest['method'], args: unknown[]): Promise<unknown> {
		const worker = this.getWorker();
		if (!worker) {
			const request: AnalysisRequest = { method, args };
			try {
				return Promise.resolve(dispatchAnalysisRequest(this.getFallback(), request));
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, method, args } satisfies AnalysisRequest);
		});
	}

	/** Replaces the workspace sources (fire-and-forget; cheap to call often). */
	setFiles(files: Record<string, string>): void {
		this.files = files;
		const worker = this.getWorker();
		if (worker) {
			worker.postMessage({ method: 'setFiles', args: [files] } satisfies AnalysisRequest);
		} else {
			this.getFallback().setFiles(files);
		}
	}

	/** Whole-workspace diagnostics (file-tagged), compiling if needed. */
	diagnostics(): Promise<IdeDiagnostic[]> {
		return this.request('diagnostics', []) as Promise<IdeDiagnostic[]>;
	}

	hover(file: string, line: number, col: number): Promise<HoverInfo | null> {
		return this.request('hover', [file, line, col]) as Promise<HoverInfo | null>;
	}

	definition(file: string, line: number, col: number): Promise<DefinitionLocation | null> {
		return this.request('definition', [file, line, col]) as Promise<DefinitionLocation | null>;
	}

	completions(file: string, line: number, col: number): Promise<CompletionEntry[]> {
		return this.request('completions', [file, line, col]) as Promise<CompletionEntry[]>;
	}
}

/** The IDE's one analysis client (worker-backed when possible). */
export const analysisClient = new AnalysisClient();
