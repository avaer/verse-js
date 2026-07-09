// monaco-setup.js
// Configures @monaco-editor/react to use the locally bundled monaco-editor
// (no CDN) and wires up the editor web worker. Import this once, client-side,
// before rendering any editor.

import { loader } from '@monaco-editor/react';

if (typeof window !== 'undefined') {
  loader.config({ monaco: import('monaco-editor') });

  globalThis.MonacoEnvironment = {
    getWorker() {
      // Verse is a custom TextMate-tokenized language; only the base editor
      // worker is needed (no TS/JSON/CSS language services).
      return new Worker(
        new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
        { type: 'module' },
      );
    },
  };
}
