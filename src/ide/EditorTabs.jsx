// EditorTabs.jsx
// Open-file tab strip with close buttons.

import React from 'react';

export default function EditorTabs({ openTabs, activeFile, onSelectTab, onCloseTab }) {
	return (
		<div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[#2b2b2b] bg-[#181818] select-none">
			{openTabs.map((name) => {
				const active = name === activeFile;
				return (
					<div
						key={name}
						onClick={() => onSelectTab(name)}
						className={`group flex cursor-pointer items-center gap-2 border-r border-[#2b2b2b] px-3 text-[13px]
							${active
								? 'border-t-2 border-t-[#3fa7ff] bg-[#1f1f1f] text-white'
								: 'bg-[#181818] text-[#9d9d9d] hover:text-[#cccccc]'
							}`}
					>
						<span className="whitespace-nowrap">{name}</span>
						<button
							title="Close tab"
							onClick={(e) => {
								e.stopPropagation();
								onCloseTab(name);
							}}
							className={`rounded px-0.5 text-[11px] leading-none hover:bg-[#3c3c3c]
								${active ? 'text-[#cccccc]' : 'invisible text-[#8a8a8a] group-hover:visible'}`}
						>
							✕
						</button>
					</div>
				);
			})}
		</div>
	);
}
