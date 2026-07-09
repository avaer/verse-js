// DebugController.js
// Cooperative execution controller for the async Verse interpreter.
//
// The interpreter awaits `onStatement(node, interpreter)` before executing
// every statement. That single hook implements:
//   - Stop (cancellation): throws VerseRunCancelled to unwind the run
//   - breakpoints: pauses before a statement on a breakpointed line
//   - stepping: step over / into / out via call-depth bookkeeping
//   - UI liveness: periodically yields the JS event loop so a hot Verse
//     `loop:` can't freeze the tab and Stop stays responsive

import { VerseRunCancelled } from '../runtime/failure.js';
import { mapToOriginalLine } from '../preprocess.js';

const YIELD_EVERY_N_STATEMENTS = 250;

export class DebugController {
	constructor(options = {}) {
		// When false (plain Run), breakpoints and stepping are ignored but
		// cancellation and event-loop yielding still work.
		this.debugEnabled = !!options.debugEnabled;
		// Maps preprocessed lines back to original source lines.
		this.lineMap = options.lineMap || null;
		this.breakpoints = new Set(options.breakpoints || []);
		this.onPaused = options.onPaused || null;
		this.onResumed = options.onResumed || null;

		this.cancelled = false;
		this.paused = false;
		this.stepMode = null; // null | 'into' | 'over' | 'out'
		this.stepDepth = 0;
		this.statementCount = 0;
		this.resumeResolve = null;

		this.cancelPromise = new Promise((_, reject) => {
			this.cancelReject = reject;
		});
		// Avoid unhandled-rejection noise if the run finishes without cancel.
		this.cancelPromise.catch(() => {});
	}

	setBreakpoints(lines) {
		this.breakpoints = new Set(lines || []);
	}

	cancel() {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;
		this.cancelReject(new VerseRunCancelled());
		// If paused at a breakpoint, wake the interpreter so it can unwind.
		this.wake();
	}

	resume() {
		this.stepMode = null;
		this.wake();
	}

	stepInto() {
		this.stepMode = 'into';
		this.wake();
	}

	stepOver(interpreter) {
		this.stepMode = 'over';
		this.stepDepth = interpreter ? interpreter.callDepth : this.pausedDepth || 0;
		this.wake();
	}

	stepOut(interpreter) {
		this.stepMode = 'out';
		this.stepDepth = interpreter ? interpreter.callDepth : this.pausedDepth || 0;
		this.wake();
	}

	wake() {
		if (this.resumeResolve) {
			const resolve = this.resumeResolve;
			this.resumeResolve = null;
			resolve();
		}
	}

	// Wraps a native `suspends` promise (e.g. Sleep) so Stop interrupts it.
	async raceCancellation(promise) {
		return await Promise.race([promise, this.cancelPromise]);
	}

	toOriginalLine(node) {
		const preprocessedLine = node?.loc?.start?.line;
		if (!preprocessedLine) {
			return null;
		}
		return mapToOriginalLine(this.lineMap, preprocessedLine);
	}

	async onStatement(node, interpreter) {
		if (this.cancelled) {
			throw new VerseRunCancelled();
		}

		this.statementCount += 1;
		if (this.statementCount % YIELD_EVERY_N_STATEMENTS === 0) {
			await new Promise(resolve => setTimeout(resolve, 0));
			if (this.cancelled) {
				throw new VerseRunCancelled();
			}
		}

		if (!this.debugEnabled) {
			return;
		}

		const line = this.toOriginalLine(node);
		let shouldPause = false;

		if (this.stepMode === 'into') {
			shouldPause = true;
		} else if (this.stepMode === 'over' && interpreter.callDepth <= this.stepDepth) {
			shouldPause = true;
		} else if (this.stepMode === 'out' && interpreter.callDepth < this.stepDepth) {
			shouldPause = true;
		} else if (line !== null && this.breakpoints.has(line)) {
			shouldPause = true;
		}

		if (!shouldPause) {
			return;
		}

		this.stepMode = null;
		this.paused = true;
		this.pausedDepth = interpreter.callDepth;

		if (this.onPaused) {
			this.onPaused({
				line,
				variables: interpreter.getScopeSnapshot(),
				callStack: [
					...interpreter.getCallStackSnapshot(),
					{ name: '(top level)', line: null },
				],
			});
		}

		await new Promise(resolve => {
			this.resumeResolve = resolve;
		});

		this.paused = false;
		if (this.onResumed) {
			this.onResumed();
		}

		if (this.cancelled) {
			throw new VerseRunCancelled();
		}
	}
}
