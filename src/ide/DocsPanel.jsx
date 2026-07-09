// DocsPanel.jsx
// Browsable reference for the builtin/core library, generated at runtime
// from the native module registry (single source of truth). Searchable;
// grouped by module; shows signatures, effects, docs, and examples.

import React, { useMemo, useState } from 'react';
import { generateBuiltinDocs } from '@/src/verse/runtime/docs.js';

function EffectBadge({ effect }) {
	return (
		<span className="rounded bg-[#3a2e14] px-1.5 py-px font-mono text-[10px] text-[#ffd659]">
			{`<${effect}>`}
		</span>
	);
}

function SymbolEntry({ symbol }) {
	const [expanded, setExpanded] = useState(false);

	return (
		<div
			className="cursor-pointer border-b border-[#242424] px-3 py-2 hover:bg-[#1f2223]"
			onClick={() => setExpanded((value) => !value)}
		>
			<div className="flex items-center gap-2">
				<span
					className={`shrink-0 font-mono text-[10px] font-bold uppercase ${symbol.kind === 'class' ? 'text-[#4ec9b0]' : 'text-[#dcdcaa]'}`}
				>
					{symbol.kind === 'class' ? 'class' : 'fn'}
				</span>
				<code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#9cdcfe]">
					{symbol.signature}
				</code>
				{symbol.effects.map((effect) => (
					<EffectBadge key={effect} effect={effect} />
				))}
			</div>

			{symbol.doc && (
				<p className={`mt-1 text-[11.5px] leading-relaxed text-[#9d9d9d] ${expanded ? '' : 'line-clamp-2'}`}>
					{symbol.doc}
				</p>
			)}

			{expanded && symbol.overloadSignatures.length > 0 && (
				<div className="mt-1.5">
					<div className="text-[10px] font-semibold tracking-wider text-[#6a6a6a] uppercase">Overloads</div>
					{symbol.overloadSignatures.map((signature) => (
						<code key={signature} className="block font-mono text-[11px] text-[#8fbfe0]">
							{signature}
						</code>
					))}
				</div>
			)}

			{expanded && symbol.example && (
				<pre className="mt-1.5 overflow-x-auto rounded bg-[#141414] p-2 font-mono text-[11px] leading-relaxed text-[#ce9178]">
					{symbol.example}
				</pre>
			)}
		</div>
	);
}

export default function DocsPanel({ onClose }) {
	const modules = useMemo(() => generateBuiltinDocs(), []);
	const [query, setQuery] = useState('');

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) {
			return modules;
		}
		return modules
			.map((module) => ({
				...module,
				symbols: module.symbols.filter(
					(symbol) =>
						symbol.name.toLowerCase().includes(needle) ||
						symbol.doc.toLowerCase().includes(needle) ||
						module.path.toLowerCase().includes(needle),
				),
			}))
			.filter((module) => module.symbols.length > 0 || module.path.toLowerCase().includes(needle));
	}, [modules, query]);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-[#2b2b2b] bg-[#181818]">
			<div className="flex h-8 shrink-0 items-center justify-between border-b border-[#2b2b2b] px-3 select-none">
				<span className="text-[11px] font-semibold tracking-wider text-[#8a8a8a] uppercase">
					Builtins
				</span>
				<button
					title="Close docs"
					onClick={onClose}
					className="rounded px-1 text-[11px] text-[#8a8a8a] hover:bg-[#3c3c3c] hover:text-white"
				>
					✕
				</button>
			</div>

			<div className="shrink-0 border-b border-[#2b2b2b] p-2">
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search builtins…"
					className="w-full rounded border border-[#3c3c3c] bg-[#212121] px-2 py-1 text-[12px] text-[#cccccc] placeholder-[#6a6a6a] outline-none focus:border-[#007fd4]"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{filtered.map((module) => (
					<div key={module.path}>
						<div className="sticky top-0 border-b border-[#2b2b2b] bg-[#1d1f20] px-3 py-1.5">
							<div className="flex items-center gap-2">
								<code className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-semibold text-[#4fc1ff]">
									{module.path}
								</code>
								{module.implicit && (
									<span className="shrink-0 rounded bg-[#12324a] px-1.5 py-px text-[10px] text-[#7bc7ff]">
										implicit
									</span>
								)}
							</div>
							{module.description && (
								<p className="mt-0.5 text-[10.5px] leading-snug text-[#7a7a7a]">{module.description}</p>
							)}
							{!module.implicit && module.symbols.length > 0 && (
								<code className="mt-0.5 block truncate font-mono text-[10.5px] text-[#6a9955]">
									{`using { ${module.path} }`}
								</code>
							)}
						</div>

						{module.symbols.map((symbol) => (
							<SymbolEntry key={symbol.name} symbol={symbol} />
						))}
						{module.symbols.length === 0 && (
							<div className="px-3 py-2 text-[11px] text-[#5a5a5a] italic">
								No symbols available in verse-js.
							</div>
						)}
					</div>
				))}

				{filtered.length === 0 && (
					<div className="px-3 py-4 text-center text-[12px] text-[#5a5a5a]">
						No builtins match “{query}”.
					</div>
				)}
			</div>

			<div className="shrink-0 border-t border-[#2b2b2b] px-3 py-1.5 text-[10px] leading-relaxed text-[#5a5a5a] select-none">
				Generated from the native module registry. Hover a builtin in the editor for the same docs.
			</div>
		</div>
	);
}
