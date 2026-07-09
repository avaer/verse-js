// Ide.jsx
// IDE shell: toolbar | sidebar | tabs + editor (+ debug panel) | console.
// Owns all app state and the Run/Debug/Stop execution pipeline:
//   source -> lexer -> parser -> checker -> markers
//          -> closure compiler -> scheduler run -> console, with a
//          DebugSession implementing breakpoints/stepping and the
//          scheduler implementing Stop (structured cancellation).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './Toolbar.jsx';
import FileSidebar from './FileSidebar.jsx';
import EditorTabs from './EditorTabs.jsx';
import EditorPane from './EditorPane.jsx';
import Console from './Console.jsx';
import DebugPanel from './DebugPanel.jsx';
import DocsPanel from './DocsPanel.jsx';
import { loadFiles, saveFiles, loadUiState, saveUiState, makeLogEntry } from './store.js';
import {
	compileVerse,
	compileProgram,
	getNativeRegistry,
	startRun as startVerseRun,
	VerseRunCancelled,
	VerseTaskCancelled,
} from '@/src/verse/pipeline';
import { DebugSession } from '@/src/verse/debug/DebugSession';
import { EXAMPLE_FILES } from './examples.js';

const MAX_LOG_ENTRIES = 2000;

export default function Ide() {
	// --- workspace state ---
	const [files, setFiles] = useState(loadFiles);
	const initialUi = useMemo(() => loadUiState(), []);
	const [openTabs, setOpenTabs] = useState(() =>
		initialUi.openTabs.filter((name) => files[name] !== undefined),
	);
	const [activeFile, setActiveFile] = useState(() =>
		files[initialUi.activeFile] !== undefined
			? initialUi.activeFile
			: Object.keys(files)[0] ?? null,
	);

	// --- layout state ---
	const [sidebarWidth, setSidebarWidth] = useState(initialUi.sidebarWidth);
	const [consoleRatio, setConsoleRatio] = useState(initialUi.consoleRatio);
	const [docsOpen, setDocsOpen] = useState(!!initialUi.docsOpen);
	const splitContainerRef = useRef(null);

	// --- run/debug state ---
	const [logs, setLogs] = useState([]);
	const [runState, setRunState] = useState('idle'); // 'idle' | 'running' | 'paused'
	const [debugSession, setDebugSession] = useState(false);
	const [pausedInfo, setPausedInfo] = useState(null); // { line, variables, callStack }
	const [breakpoints, setBreakpoints] = useState({}); // { [file]: number[] }
	const [diagnostics, setDiagnostics] = useState({}); // { [file]: [diagnostic] }

	const [runFile, setRunFile] = useState(null); // file the current run executes
	const sessionRef = useRef(null); // DebugSession of the current run
	const runRef = useRef(null); // VerseRun handle (stop())
	const runStateRef = useRef(runState);
	useEffect(() => {
		runStateRef.current = runState;
	}, [runState]);

	// --- persistence ---
	useEffect(() => {
		const timeout = setTimeout(() => saveFiles(files), 300);
		return () => clearTimeout(timeout);
	}, [files]);

	useEffect(() => {
		saveUiState({ activeFile, openTabs, sidebarWidth, consoleRatio, docsOpen });
	}, [activeFile, openTabs, sidebarWidth, consoleRatio, docsOpen]);

	// --- logging ---
	const appendLog = useCallback((level, text, options) => {
		setLogs((previous) => {
			const next = [...previous, makeLogEntry(level, text, options)];
			return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
		});
	}, []);

	// --- diagnostics on a debounce while typing ---
	useEffect(() => {
		if (!activeFile || files[activeFile] === undefined) {
			return;
		}
		const source = files[activeFile];
		const timeout = setTimeout(() => {
			const result = compileVerse(source);
			setDiagnostics((previous) => ({
				...previous,
				[activeFile]: result.diagnostics,
			}));
		}, 300);
		return () => clearTimeout(timeout);
	}, [files, activeFile]);

	// --- file operations ---
	const openFile = useCallback((name) => {
		setOpenTabs((tabs) => (tabs.includes(name) ? tabs : [...tabs, name]));
		setActiveFile(name);
	}, []);

	const createFile = useCallback((name) => {
		setFiles((previous) => ({
			...previous,
			[name]: `using { /Fortnite.com/Devices }\nusing { /Verse.org/Simulation }\nusing { /UnrealEngine.com/Temporary/Diagnostics }\n\nmy_device := class(creative_device):\n\n    OnBegin<override>()<suspends> : void =\n        Print("Hello from ${name}")\n`,
		}));
		setOpenTabs((tabs) => [...tabs, name]);
		setActiveFile(name);
	}, []);

	const renameFile = useCallback((from, to) => {
		setFiles((previous) => {
			const next = {};
			for (const [key, value] of Object.entries(previous)) {
				next[key === from ? to : key] = value;
			}
			return next;
		});
		setOpenTabs((tabs) => tabs.map((tab) => (tab === from ? to : tab)));
		setActiveFile((current) => (current === from ? to : current));
		setBreakpoints((previous) => {
			const next = { ...previous };
			if (next[from]) {
				next[to] = next[from];
				delete next[from];
			}
			return next;
		});
	}, []);

	const deleteFile = useCallback((name) => {
		setFiles((previous) => {
			const next = { ...previous };
			delete next[name];
			return next;
		});
		setOpenTabs((tabs) => {
			const next = tabs.filter((tab) => tab !== name);
			setActiveFile((current) => (current === name ? next[next.length - 1] ?? null : current));
			return next;
		});
	}, []);

	const closeTab = useCallback((name) => {
		setOpenTabs((tabs) => {
			const index = tabs.indexOf(name);
			const next = tabs.filter((tab) => tab !== name);
			setActiveFile((current) =>
				current === name ? next[Math.min(index, next.length - 1)] ?? null : current,
			);
			return next;
		});
	}, []);

	const changeFileContent = useCallback((name, content) => {
		setFiles((previous) => (previous[name] === content ? previous : { ...previous, [name]: content }));
	}, []);

	// --- breakpoints ---
	const toggleBreakpoint = useCallback((line) => {
		if (!activeFile) {
			return;
		}
		setBreakpoints((previous) => {
			const current = new Set(previous[activeFile] || []);
			if (current.has(line)) {
				current.delete(line);
			} else {
				current.add(line);
			}
			const next = { ...previous, [activeFile]: [...current] };
			// Live-update the running debug session.
			if (sessionRef.current && runFile === activeFile) {
				sessionRef.current.setBreakpoints(next[activeFile]);
			}
			return next;
		});
	}, [activeFile, runFile]);

	// --- execution ---
	const startRun = useCallback((debugEnabled) => {
		if (runStateRef.current !== 'idle' || !activeFile) {
			return;
		}
		const fileName = activeFile;
		const source = files[fileName];

		appendLog('system', `— ${debugEnabled ? 'Debugging' : 'Running'} ${fileName} —`);

		const result = compileVerse(source, { strict: true });
		setDiagnostics((previous) => ({ ...previous, [fileName]: result.diagnostics }));
		if (!result.ok) {
			for (const diagnostic of result.diagnostics.filter((d) => d.severity === 'error')) {
				appendLog('error', diagnostic.message, {
					file: fileName,
					line: diagnostic.startLine,
				});
			}
			return;
		}

		const session = new DebugSession({
			debugEnabled,
			breakpoints: breakpoints[fileName] || [],
			onPaused: (info) => {
				setRunState('paused');
				setPausedInfo(info);
			},
			onResumed: () => {
				setRunState('running');
				setPausedInfo(null);
			},
		});

		let compiled;
		try {
			compiled = compileProgram(
				result.program,
				getNativeRegistry(),
				result.check.globalSlotCount,
				result.check.deviceClasses,
				{ debug: debugEnabled },
			);
		} catch (error) {
			appendLog('error', `Compile error: ${error.message}`, { file: fileName });
			return;
		}

		const run = startVerseRun(compiled, {
			onOutput: (level, text) => appendLog(level, text),
			debug: session,
			persistence: {
				load: (key) => window.localStorage.getItem(key),
				store: (key, json) => window.localStorage.setItem(key, json),
			},
		});

		sessionRef.current = session;
		runRef.current = run;
		setRunFile(fileName);
		setDebugSession(debugEnabled);
		// The run starts synchronously inside startVerseRun, so an early
		// breakpoint may already have paused (and set state) by now; don't
		// clobber that with 'running'.
		if (!session.paused) {
			setRunState('running');
			setPausedInfo(null);
		}

		run.done
			.then(() => {
				appendLog('system', '— Finished —');
			})
			.catch((error) => {
				if (error instanceof VerseRunCancelled || error instanceof VerseTaskCancelled) {
					appendLog('system', '— Stopped —');
					return;
				}
				appendLog('error', `Runtime error: ${error.message}`, {
					file: fileName,
					line: error.line ?? run.ctx.line ?? null,
				});
			})
			.finally(() => {
				setRunState('idle');
				setDebugSession(false);
				setPausedInfo(null);
				sessionRef.current = null;
				runRef.current = null;
				setRunFile(null);
			});
	}, [activeFile, files, breakpoints, appendLog]);

	const stopRun = useCallback(() => {
		runRef.current?.stop();
		// If paused at a breakpoint, wake the session so the run can unwind.
		sessionRef.current?.wake();
	}, []);

	const continueRun = useCallback(() => {
		sessionRef.current?.resume();
	}, []);

	const stepOver = useCallback(() => {
		sessionRef.current?.stepOver();
	}, []);

	const stepInto = useCallback(() => {
		sessionRef.current?.stepInto();
	}, []);

	const stepOut = useCallback(() => {
		sessionRef.current?.stepOut();
	}, []);

	// --- keyboard shortcuts ---
	useEffect(() => {
		const onKeyDown = (event) => {
			if (event.key === 'F5' && event.shiftKey) {
				event.preventDefault();
				stopRun();
			} else if (event.key === 'F5') {
				event.preventDefault();
				if (runStateRef.current === 'paused') {
					continueRun();
				} else if (runStateRef.current === 'idle') {
					startRun(false);
				}
			} else if (event.key === 'F10' && runStateRef.current === 'paused') {
				event.preventDefault();
				stepOver();
			} else if (event.key === 'F11' && runStateRef.current === 'paused') {
				event.preventDefault();
				if (event.shiftKey) {
					stepOut();
				} else {
					stepInto();
				}
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [startRun, stopRun, continueRun, stepOver, stepInto, stepOut]);

	// --- drag-resize (pocketuniverse pattern: mousedown + document mousemove) ---
	const handleSidebarDragStart = useCallback((event) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = sidebarWidth;
		const onMove = (moveEvent) => {
			setSidebarWidth(Math.min(420, Math.max(140, startWidth + moveEvent.clientX - startX)));
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}, [sidebarWidth]);

	const handleConsoleDragStart = useCallback((event) => {
		event.preventDefault();
		const container = splitContainerRef.current;
		if (!container) {
			return;
		}
		const rect = container.getBoundingClientRect();
		const onMove = (moveEvent) => {
			const ratio = (rect.bottom - moveEvent.clientY) / rect.height;
			setConsoleRatio(Math.min(0.7, Math.max(0.12, ratio)));
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}, []);

	// --- console jump-to-line ---
	const jumpTo = useCallback((file, line) => {
		if (file && files[file] !== undefined) {
			openFile(file);
		}
		// EditorPane reveals the paused line automatically; for error jumps we
		// reuse the same mechanism by flashing pausedInfo-like state is overkill,
		// so we rely on Monaco's revealLine via a custom event.
		window.dispatchEvent(new CustomEvent('verse-reveal-line', { detail: { line } }));
	}, [files, openFile]);

	const resetWorkspace = useCallback(() => {
		if (!window.confirm('Reset workspace to the bundled examples? This discards your edits.')) {
			return;
		}
		const fresh = { ...EXAMPLE_FILES };
		setFiles(fresh);
		const names = Object.keys(fresh);
		setOpenTabs([names[0]]);
		setActiveFile(names[0]);
		setBreakpoints({});
	}, []);

	const showDebugPanel = debugSession || runState === 'paused';
	const pausedLineForActiveFile =
		runState === 'paused' && runFile === activeFile ? pausedInfo?.line ?? null : null;

	return (
		<div className="flex h-full flex-col overflow-hidden bg-[#181818] text-[#cccccc]">
			<Toolbar
				runState={runState}
				debugSession={debugSession}
				onRun={() => startRun(false)}
				onDebug={() => startRun(true)}
				onStop={stopRun}
				onContinue={continueRun}
				onStepOver={stepOver}
				onStepInto={stepInto}
				onStepOut={stepOut}
				docsOpen={docsOpen}
				onToggleDocs={() => setDocsOpen((value) => !value)}
			/>

			<div className="flex min-h-0 flex-1 overflow-hidden">
				{/* sidebar */}
				<div style={{ width: sidebarWidth }} className="shrink-0 border-r border-[#2b2b2b]">
					<FileSidebar
						files={files}
						activeFile={activeFile}
						onOpenFile={openFile}
						onCreateFile={createFile}
						onRenameFile={renameFile}
						onDeleteFile={deleteFile}
					/>
				</div>
				<div
					onMouseDown={handleSidebarDragStart}
					className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[#3fa7ff66]"
				/>

				{/* editor + console column */}
				<div className="flex min-w-0 flex-1 flex-col">
					<EditorTabs
						openTabs={openTabs}
						activeFile={activeFile}
						onSelectTab={setActiveFile}
						onCloseTab={closeTab}
					/>

					<div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col">
						<div
							style={{ flex: `${1 - consoleRatio} 1 0%` }}
							className="flex min-h-0 overflow-hidden"
						>
							{activeFile && files[activeFile] !== undefined ? (
								<div className="min-w-0 flex-1">
									<EditorPane
										fileName={activeFile}
										value={files[activeFile]}
										onChange={(content) => changeFileContent(activeFile, content)}
										diagnostics={diagnostics[activeFile] || []}
										breakpoints={new Set(breakpoints[activeFile] || [])}
										onToggleBreakpoint={toggleBreakpoint}
										pausedLine={pausedLineForActiveFile}
										onRunShortcut={() => {
											if (runStateRef.current === 'idle') {
												startRun(false);
											} else if (runStateRef.current === 'paused') {
												continueRun();
											}
										}}
									/>
								</div>
							) : (
								<div className="flex flex-1 flex-col items-center justify-center gap-2 text-[#5a5a5a] select-none">
									<div>No file open.</div>
									<button
										onClick={resetWorkspace}
										className="rounded border border-[#3c3c3c] px-3 py-1 text-[12px] text-[#cccccc] hover:bg-[#2a2d2e]"
									>
										Restore example files
									</button>
								</div>
							)}

							{showDebugPanel && (
								<div className="w-72 shrink-0">
									<DebugPanel
										variables={pausedInfo?.variables}
										callStack={pausedInfo?.callStack}
										pausedLine={pausedInfo?.line}
										tasks={pausedInfo?.tasks}
									/>
								</div>
							)}

							{docsOpen && (
								<div className="w-80 shrink-0">
									<DocsPanel onClose={() => setDocsOpen(false)} />
								</div>
							)}
						</div>

						<div
							onMouseDown={handleConsoleDragStart}
							className="h-1 shrink-0 cursor-row-resize bg-[#2b2b2b] hover:bg-[#3fa7ff66]"
						/>

						<div style={{ flex: `${consoleRatio} 1 0%` }} className="min-h-0 overflow-hidden">
							<Console logs={logs} onClear={() => setLogs([])} onJumpTo={jumpTo} />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
