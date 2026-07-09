// DebugPanel.jsx
// Shown while paused in the debugger: variables in scope, the call stack,
// and the live task list (structured concurrency).

import React from 'react';

const TASK_STATE_COLORS = {
	running: '#4ec9b0',
	completed: '#8a8a8a',
	failed: '#f48771',
	cancelled: '#5a5a5a',
};

export default function DebugPanel({ variables, callStack, pausedLine, tasks }) {
	return (
		<div
			data-testid="debug-panel"
			className="flex h-full min-h-0 flex-col overflow-hidden border-l border-[#2b2b2b] bg-[#181818]"
		>
			<div className="flex h-8 shrink-0 items-center border-b border-[#2b2b2b] px-3 select-none">
				<span className="text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase">
					Debug
				</span>
				{pausedLine != null && (
					<span className="ml-2 text-[11px] text-[#ffd659]">paused at line {pausedLine}</span>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase select-none">
					Variables
				</div>
				{(!variables || variables.length === 0) && (
					<div className="px-3 pb-2 text-[12px] text-[#5a5a5a]">No variables in scope.</div>
				)}
				<table className="w-full table-fixed border-collapse">
					<tbody>
						{(variables || []).map((variable) => (
							<tr key={variable.name} className="hover:bg-[#212425]">
								<td className="w-[38%] truncate px-3 py-0.5 font-mono text-[12px] text-[#9cdcfe]">
									{variable.name}
								</td>
								<td className="truncate py-0.5 pr-3 font-mono text-[12px] text-[#ce9178]">
									{variable.value}
								</td>
							</tr>
						))}
					</tbody>
				</table>

				<div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase select-none">
					Call Stack
				</div>
				{(callStack || []).map((frame, index) => (
					<div
						key={`${frame.name}-${index}`}
						className={`flex items-center gap-2 px-3 py-0.5 font-mono text-[12px] ${index === 0 ? 'text-[#dcdcaa]' : 'text-[#8a8a8a]'}`}
					>
						<span className="truncate">{frame.name}</span>
						{frame.line != null && (
							<span className="shrink-0 text-[11px] text-[#5a5a5a]">
								{frame.file ? `${frame.file}:${frame.line}` : `line ${frame.line}`}
							</span>
						)}
					</div>
				))}

				{tasks && tasks.length > 0 && (
					<>
						<div className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase select-none">
							Tasks
						</div>
						{tasks.map((task) => (
							<div
								key={task.id}
								className="flex items-center gap-2 px-3 py-0.5 font-mono text-[12px] text-[#cccccc]"
							>
								<span
									className="inline-block h-2 w-2 shrink-0 rounded-full"
									style={{ backgroundColor: TASK_STATE_COLORS[task.state] || '#8a8a8a' }}
								/>
								<span className="truncate">{task.name}</span>
								<span className="ml-auto shrink-0 text-[11px] text-[#5a5a5a]">{task.state}</span>
							</div>
						))}
					</>
				)}
			</div>
		</div>
	);
}
