// DebugPanel.jsx
// Shown while paused in the debugger: variables in scope and the call stack.

import React from 'react';

export default function DebugPanel({ variables, callStack, pausedLine }) {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-[#2b2b2b] bg-[#181818]">
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
								<td className="w-[20%] truncate py-0.5 pr-1 font-mono text-[11px] text-[#4ec9b0]">
									{variable.type}
									{variable.isConstant ? '' : ' (var)'}
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
							<span className="shrink-0 text-[11px] text-[#5a5a5a]">line {frame.line}</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
