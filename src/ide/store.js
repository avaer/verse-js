// store.js
// Persistence + small shared helpers for IDE state. Files and layout are kept
// in localStorage so the workspace survives reloads; React state lives in
// Ide.jsx and syncs through these helpers.

import { EXAMPLE_FILES, DEFAULT_ACTIVE_FILE } from './examples.js';

const FILES_KEY = 'verse-js.files.v1';
const UI_KEY = 'verse-js.ui.v1';

export function loadFiles() {
	if (typeof window === 'undefined') {
		return { ...EXAMPLE_FILES };
	}
	try {
		const raw = window.localStorage.getItem(FILES_KEY);
		if (!raw) {
			return { ...EXAMPLE_FILES };
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
			return { ...EXAMPLE_FILES };
		}
		return parsed;
	} catch {
		return { ...EXAMPLE_FILES };
	}
}

export function saveFiles(files) {
	try {
		window.localStorage.setItem(FILES_KEY, JSON.stringify(files));
	} catch {
		// localStorage full or unavailable; edits stay in memory.
	}
}

export function loadUiState() {
	const fallback = {
		activeFile: DEFAULT_ACTIVE_FILE,
		openTabs: [DEFAULT_ACTIVE_FILE],
		sidebarWidth: 200,
		consoleRatio: 0.3,
	};
	if (typeof window === 'undefined') {
		return fallback;
	}
	try {
		const raw = window.localStorage.getItem(UI_KEY);
		if (!raw) {
			return fallback;
		}
		return { ...fallback, ...JSON.parse(raw) };
	} catch {
		return fallback;
	}
}

export function saveUiState(state) {
	try {
		window.localStorage.setItem(UI_KEY, JSON.stringify(state));
	} catch {
		// non-fatal
	}
}

let nextLogId = 1;

export function makeLogEntry(level, text, options = {}) {
	return {
		id: nextLogId++,
		level, // 'stdout' | 'error' | 'system'
		text,
		file: options.file ?? null,
		line: options.line ?? null,
		timestamp: Date.now(),
	};
}
