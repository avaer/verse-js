// Toolbar.jsx
// Top toolbar: Run / Debug / Stop plus step controls while paused.

import React from 'react';

function ToolbarButton({ title, onClick, disabled, children, accent }) {
	return (
		<button
			title={title}
			onClick={onClick}
			disabled={disabled}
			className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors
				${disabled
					? 'cursor-default text-[#5a5a5a]'
					: accent === 'green'
						? 'text-[#89d185] hover:bg-[#2a2d2e]'
						: accent === 'red'
							? 'text-[#f48771] hover:bg-[#2a2d2e]'
							: 'text-[#cccccc] hover:bg-[#2a2d2e]'
				}`}
		>
			{children}
		</button>
	);
}

export default function Toolbar({
	runState, // 'idle' | 'running' | 'paused'
	debugSession, // true when the current run honors breakpoints
	onRun,
	onDebug,
	onStop,
	onContinue,
	onStepOver,
	onStepInto,
	onStepOut,
	docsOpen,
	onToggleDocs,
	onResetWorkspace,
}) {
	const idle = runState === 'idle';
	const paused = runState === 'paused';

	return (
		<div className="flex h-9 shrink-0 items-center gap-1 border-b border-[#2b2b2b] bg-[#181818] px-2 select-none">
			<span className="mr-2 flex items-center gap-2 px-1 text-[13px] font-semibold tracking-wide text-[#e8e8e8]">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
					<path d="M2 2l5 12h2L4 2H2zm8 0l-2.2 5.3 1.1 2.6L12 2h-2z" fill="#3fa7ff" />
					<path d="M14 2l-3 7.2 1 2.4L16 2h-2z" fill="#7bc7ff" opacity="0.7" />
				</svg>
				Verse IDE
			</span>

			<ToolbarButton title="Run (F5)" onClick={onRun} disabled={!idle} accent="green">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
					<path d="M4 2l10 6-10 6V2z" />
				</svg>
				Run
			</ToolbarButton>

			<ToolbarButton title="Start Debugging (breakpoints active)" onClick={onDebug} disabled={!idle} accent="green">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
					<path d="M4 2l7 4.2V2h2v12h-2V9.8L4 14V2z" transform="rotate(0 8 8)" opacity="0" />
					<path d="M5 2l8 6-8 6V2z" />
					<circle cx="3" cy="8" r="2" />
				</svg>
				Debug
			</ToolbarButton>

			<ToolbarButton title="Stop (Shift+F5)" onClick={onStop} disabled={idle} accent="red">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
					<rect x="3" y="3" width="10" height="10" rx="1" />
				</svg>
				Stop
			</ToolbarButton>

			{(paused || (runState === 'running' && debugSession)) && (
				<>
					<div className="mx-1 h-4 w-px bg-[#3c3c3c]" />

					<ToolbarButton title="Continue (F5)" onClick={onContinue} disabled={!paused}>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
							<path d="M3 2l8 6-8 6V2z" />
							<rect x="12" y="2" width="2" height="12" />
						</svg>
						Continue
					</ToolbarButton>

					<ToolbarButton title="Step Over (F10)" onClick={onStepOver} disabled={!paused}>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
							<path d="M2 7a6 6 0 0 1 11-2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
							<path d="M13.5 1v4h-4" stroke="currentColor" strokeWidth="1.6" fill="none" />
							<circle cx="8" cy="12" r="2" />
						</svg>
						Step Over
					</ToolbarButton>

					<ToolbarButton title="Step Into (F11)" onClick={onStepInto} disabled={!paused}>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
							<path d="M8 1v8M8 9l-3-3M8 9l3-3" stroke="currentColor" strokeWidth="1.6" fill="none" />
							<circle cx="8" cy="13" r="2" />
						</svg>
						Step Into
					</ToolbarButton>

					<ToolbarButton title="Step Out (Shift+F11)" onClick={onStepOut} disabled={!paused}>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
							<path d="M8 9V1M8 1L5 4M8 1l3 3" stroke="currentColor" strokeWidth="1.6" fill="none" />
							<circle cx="8" cy="13" r="2" />
						</svg>
						Step Out
					</ToolbarButton>
				</>
			)}

			<div className="flex-1" />

			<span className="px-2 text-[11px] text-[#8a8a8a]">
				{runState === 'running' && (debugSession ? 'Debugging…' : 'Running…')}
				{runState === 'paused' && 'Paused on breakpoint'}
			</span>

			<button
				title="Reset workspace to the bundled example files (discards edits and clears persistent Verse data)"
				onClick={onResetWorkspace}
				disabled={runState !== 'idle'}
				className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors
					${runState !== 'idle' ? 'cursor-default text-[#5a5a5a]' : 'text-[#cccccc] hover:bg-[#2a2d2e]'}`}
			>
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
					<path
						d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
				Reset
			</button>

			<button
				title="Builtin library reference"
				onClick={onToggleDocs}
				className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors
					${docsOpen ? 'bg-[#2a2d2e] text-white' : 'text-[#cccccc] hover:bg-[#2a2d2e]'}`}
			>
				<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
					<path d="M3 2h6a2 2 0 0 1 2 2v10l-1-.6a3 3 0 0 0-3-.02L3 14V2z" opacity="0.55" />
					<path d="M4 1h6a3 3 0 0 1 3 3v10h-1.5V4A1.5 1.5 0 0 0 10 2.5H4V1z" />
				</svg>
				Docs
			</button>
		</div>
	);
}
