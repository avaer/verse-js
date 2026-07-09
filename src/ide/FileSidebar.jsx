// FileSidebar.jsx
// Workspace file list: open, create, rename, delete .verse files.

import React, { useState } from 'react';

function VerseFileIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden>
			<path d="M2 2l4 12h1.5L4 2H2z" fill="#3fa7ff" />
			<path d="M9 2L7.2 7.4l.9 2.7L11 2H9z" fill="#7bc7ff" />
		</svg>
	);
}

export default function FileSidebar({
	files,
	activeFile,
	onOpenFile,
	onCreateFile,
	onRenameFile,
	onDeleteFile,
}) {
	const [renaming, setRenaming] = useState(null);
	const [renameValue, setRenameValue] = useState('');

	const fileNames = Object.keys(files).sort();

	const startCreate = () => {
		let base = 'untitled';
		let candidate = `${base}.verse`;
		let n = 1;
		while (files[candidate] !== undefined) {
			candidate = `${base}-${n++}.verse`;
		}
		onCreateFile(candidate);
	};

	const commitRename = () => {
		const from = renaming;
		setRenaming(null);
		if (!from) {
			return;
		}
		let to = renameValue.trim();
		if (!to || to === from) {
			return;
		}
		if (!to.endsWith('.verse')) {
			to += '.verse';
		}
		if (files[to] !== undefined) {
			return;
		}
		onRenameFile(from, to);
	};

	return (
		<div className="flex h-full flex-col overflow-hidden bg-[#181818]">
			<div className="flex h-8 shrink-0 items-center justify-between px-3 text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase select-none">
				Explorer
				<button
					title="New .verse file"
					onClick={startCreate}
					className="rounded px-1 text-sm leading-none text-[#cccccc] hover:bg-[#2a2d2e]"
				>
					+
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto py-0.5">
				{fileNames.map((name) => (
					<div
						key={name}
						className={`group flex cursor-pointer items-center gap-1.5 px-3 py-[3px] text-[13px]
							${name === activeFile
								? 'bg-[#2a2d2e] text-[#ffffff]'
								: 'text-[#cccccc] hover:bg-[#212425]'
							}`}
						onClick={() => onOpenFile(name)}
						onDoubleClick={() => {
							setRenaming(name);
							setRenameValue(name);
						}}
					>
						<VerseFileIcon />
						{renaming === name ? (
							<input
								autoFocus
								value={renameValue}
								onChange={(e) => setRenameValue(e.target.value)}
								onBlur={commitRename}
								onKeyDown={(e) => {
									if (e.key === 'Enter') commitRename();
									if (e.key === 'Escape') setRenaming(null);
								}}
								onClick={(e) => e.stopPropagation()}
								className="min-w-0 flex-1 rounded border border-[#007fd4] bg-[#313131] px-1 text-[12px] text-white outline-none"
							/>
						) : (
							<span className="min-w-0 flex-1 truncate">{name}</span>
						)}
						<button
							title={`Delete ${name}`}
							onClick={(e) => {
								e.stopPropagation();
								if (window.confirm(`Delete ${name}?`)) {
									onDeleteFile(name);
								}
							}}
							className="hidden rounded px-1 text-[11px] text-[#8a8a8a] group-hover:block hover:bg-[#3c3c3c] hover:text-white"
						>
							✕
						</button>
					</div>
				))}

				{fileNames.length === 0 && (
					<div className="px-3 py-2 text-[12px] text-[#6a6a6a]">
						No files. Click + to create one.
					</div>
				)}
			</div>

			<div className="shrink-0 border-t border-[#2b2b2b] px-3 py-2 text-[10px] leading-relaxed text-[#6a6a6a] select-none">
				Double-click to rename.
				<br />
				Files persist to localStorage.
			</div>
		</div>
	);
}
