// diagnostics.ts
// Shared diagnostic shape for the compile pipeline (front end + sema).

import { Span } from '../frontend/tokens';

export interface Diagnostic {
	message: string;
	severity: 'error' | 'warning';
	span: Span | null;
	code?: string;
	/** Workspace file the diagnostic belongs to (multi-file compiles). */
	file?: string;
}

export function diagnosticAt(message: string, span: Span | null, severity: 'error' | 'warning' = 'error', code?: string): Diagnostic {
	return { message, severity, span, code };
}
