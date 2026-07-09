// analysis.worker.ts
// Web Worker entry for IDE semantic analysis. Owns its own Verse host
// (same modules as the main-thread ideHost, so results match) and an
// AnalysisEngine over it; the main thread talks to it through the tiny
// request/response protocol in analysis-engine.ts. Compiling and checking
// the workspace on every keystroke happens here, off the UI thread.

import { createHost } from '../verse';
import { uefnModules } from '../verse/extras/uefn';
import {
	AnalysisEngine, AnalysisRequest, AnalysisResponse, dispatchAnalysisRequest,
} from './analysis-engine';

const engine = new AnalysisEngine(createHost({ modules: uefnModules }));

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
	const request = event.data;
	if (request.id === undefined) {
		// Fire-and-forget (setFiles): no response expected.
		dispatchAnalysisRequest(engine, request);
		return;
	}
	let response: AnalysisResponse;
	try {
		response = { id: request.id, ok: true, result: dispatchAnalysisRequest(engine, request) };
	} catch (error) {
		response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	self.postMessage(response);
};
