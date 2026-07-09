// Console.jsx
// Output panel: streaming log entries with level colors, timestamps,
// stick-to-bottom autoscroll, Clear button, and click-to-jump for entries
// that carry a source location.

import React, { useEffect, useRef, useState } from 'react';

function formatTime(timestamp) {
	const date = new Date(timestamp);
	const pad = (n, w = 2) => String(n).padStart(w, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const LEVEL_STYLES = {
	stdout: 'text-[#cccccc]',
	error: 'text-[#f48771]',
	system: 'text-[#6a9955] italic',
};

export default function Console({ logs, onClear, onJumpTo }) {
	const scrollRef = useRef(null);
	const [stickToBottom, setStickToBottom] = useState(true);

	useEffect(() => {
		if (stickToBottom && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [logs, stickToBottom]);

	const handleScroll = () => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
		setStickToBottom(atBottom);
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-[#181818]">
			<div className="flex h-8 shrink-0 items-center justify-between border-b border-[#2b2b2b] px-3 select-none">
				<span className="text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase">
					Console
				</span>
				<button
					onClick={onClear}
					className="rounded px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#2a2d2e]"
				>
					Clear
				</button>
			</div>

			<div
				ref={scrollRef}
				onScroll={handleScroll}
				data-testid="console-output"
				className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-[12px] leading-[1.5]"
				style={{ fontFamily: "var(--font-geist-mono), Consolas, monospace" }}
			>
				{logs.length === 0 && (
					<div className="py-1 text-[#5a5a5a] select-none">
						Press Run to execute the active .verse file. Output appears here.
					</div>
				)}
				{logs.map((entry) => (
					<div key={entry.id} className="flex gap-2 whitespace-pre-wrap">
						<span className="shrink-0 text-[#5a5a5a] select-none">{formatTime(entry.timestamp)}</span>
						<span className={`min-w-0 flex-1 ${LEVEL_STYLES[entry.level] || LEVEL_STYLES.stdout}`}>
							{entry.text}
							{entry.line != null && (
								<button
									onClick={() => onJumpTo?.(entry.file, entry.line)}
									className="ml-2 text-[#3fa7ff] underline decoration-dotted hover:text-[#7bc7ff]"
								>
									{entry.file ? `${entry.file}:${entry.line}` : `line ${entry.line}`}
								</button>
							)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
