// EditorPane.jsx
// Monaco wrapper: Verse language registration, diagnostics markers,
// breakpoint gutter (click the glyph margin), and the yellow current-line
// highlight while paused in the debugger.

import React, { useEffect, useRef } from 'react';
import '@/src/monaco/monaco-setup.js';
import Editor from '@monaco-editor/react';
import { registerVerseLanguage } from '@/src/monaco/verse-language.js';

export default function EditorPane({
	fileName,
	value,
	onChange,
	diagnostics, // [{ message, severity, startLine, startColumn, endLine, endColumn }]
	breakpoints, // Set<number> for this file
	onToggleBreakpoint,
	pausedLine, // number | null (only for this file)
	onRunShortcut,
}) {
	const editorRef = useRef(null);
	const monacoRef = useRef(null);
	const breakpointDecorations = useRef(null);
	const pausedDecorations = useRef(null);
	const containerRef = useRef(null);

	// Keep callback refs fresh for Monaco listeners registered once on mount.
	const toggleBreakpointRef = useRef(onToggleBreakpoint);
	const runShortcutRef = useRef(onRunShortcut);
	useEffect(() => {
		toggleBreakpointRef.current = onToggleBreakpoint;
		runShortcutRef.current = onRunShortcut;
	});

	const handleBeforeMount = (monaco) => {
		registerVerseLanguage(monaco).catch((error) => {
			console.error('Failed to register Verse language support', error);
		});
	};

	const handleMount = (editor, monaco) => {
		editorRef.current = editor;
		monacoRef.current = monaco;

		editor.onMouseDown((event) => {
			const target = event.target;
			if (
				target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
				target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
			) {
				const line = target.position?.lineNumber;
				if (line && toggleBreakpointRef.current) {
					toggleBreakpointRef.current(line);
				}
			}
		});

		editor.addAction({
			id: 'verse.run',
			label: 'Run Verse',
			keybindings: [monaco.KeyCode.F5],
			run: () => {
				runShortcutRef.current?.();
			},
		});

		breakpointDecorations.current = editor.createDecorationsCollection([]);
		pausedDecorations.current = editor.createDecorationsCollection([]);
	};

	// Console "jump to line" requests (e.g. clicking an error's file:line).
	useEffect(() => {
		const onReveal = (event) => {
			const line = event.detail?.line;
			const editor = editorRef.current;
			if (!line || !editor) {
				return;
			}
			editor.revealLineInCenter(line);
			editor.setPosition({ lineNumber: line, column: 1 });
			editor.focus();
		};
		window.addEventListener('verse-reveal-line', onReveal);
		return () => window.removeEventListener('verse-reveal-line', onReveal);
	}, []);

	// Relayout when the pane is resized by the split-drag handles.
	useEffect(() => {
		const container = containerRef.current;
		if (!container || typeof ResizeObserver === 'undefined') {
			return;
		}
		let frame = null;
		const observer = new ResizeObserver(() => {
			if (frame) {
				cancelAnimationFrame(frame);
			}
			frame = requestAnimationFrame(() => {
				editorRef.current?.layout();
			});
		});
		observer.observe(container);
		return () => {
			observer.disconnect();
			if (frame) {
				cancelAnimationFrame(frame);
			}
		};
	}, []);

	// Diagnostics -> squiggles.
	useEffect(() => {
		const monaco = monacoRef.current;
		const editor = editorRef.current;
		if (!monaco || !editor) {
			return;
		}
		const model = editor.getModel();
		if (!model) {
			return;
		}
		const markers = (diagnostics || []).map((diagnostic) => ({
			message: diagnostic.message,
			severity: diagnostic.severity === 'warning'
				? monaco.MarkerSeverity.Warning
				: monaco.MarkerSeverity.Error,
			startLineNumber: clampLine(diagnostic.startLine, model),
			startColumn: diagnostic.startColumn || 1,
			endLineNumber: clampLine(diagnostic.endLine || diagnostic.startLine, model),
			endColumn: diagnostic.endColumn || model.getLineMaxColumn(clampLine(diagnostic.endLine || diagnostic.startLine, model)),
		}));
		monaco.editor.setModelMarkers(model, 'verse', markers);
	}, [diagnostics, value, fileName]);

	// Breakpoints -> red glyph dots.
	useEffect(() => {
		const monaco = monacoRef.current;
		if (!monaco || !breakpointDecorations.current) {
			return;
		}
		const decorations = [...(breakpoints || [])].map((line) => ({
			range: new monaco.Range(line, 1, line, 1),
			options: {
				isWholeLine: false,
				glyphMarginClassName: 'verse-breakpoint-glyph',
				glyphMarginHoverMessage: { value: 'Breakpoint' },
				stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			},
		}));
		breakpointDecorations.current.set(decorations);
	}, [breakpoints, value, fileName]);

	// Paused execution line -> yellow highlight + arrow glyph.
	useEffect(() => {
		const monaco = monacoRef.current;
		const editor = editorRef.current;
		if (!monaco || !editor || !pausedDecorations.current) {
			return;
		}
		if (!pausedLine) {
			pausedDecorations.current.set([]);
			return;
		}
		pausedDecorations.current.set([
			{
				range: new monaco.Range(pausedLine, 1, pausedLine, 1),
				options: {
					isWholeLine: true,
					className: 'verse-paused-line',
					glyphMarginClassName: 'verse-paused-glyph',
				},
			},
		]);
		editor.revealLineInCenterIfOutsideViewport(pausedLine);
	}, [pausedLine, fileName]);

	return (
		<div ref={containerRef} className="h-full min-h-0 w-full">
			<Editor
				path={fileName}
				defaultLanguage="verse"
				language="verse"
				theme="verse-dark"
				value={value}
				onChange={(next) => onChange(next ?? '')}
				beforeMount={handleBeforeMount}
				onMount={handleMount}
				options={{
					fontSize: 13,
					fontFamily: "var(--font-geist-mono), 'Cascadia Code', Consolas, monospace",
					minimap: { enabled: false },
					glyphMargin: true,
					automaticLayout: true,
					scrollBeyondLastLine: false,
					renderLineHighlight: 'line',
					fixedOverflowWidgets: true,
					tabSize: 4,
					insertSpaces: true,
					detectIndentation: false,
					padding: { top: 8 },
				}}
			/>
		</div>
	);
}

function clampLine(line, model) {
	const max = model.getLineCount();
	return Math.min(Math.max(1, line || 1), max);
}
