// serve-pages.mjs
// Serves the GitHub Pages static export (out/) under the /verse-js base
// path, mimicking https://<user>.github.io/verse-js/ so the export can be
// smoke-tested locally:
//   GITHUB_PAGES=true pnpm build && node scripts/serve-pages.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const BASE = '/verse-js';
const ROOT = join(process.cwd(), 'out');
const PORT = Number(process.env.PORT ?? 3211);

const MIME = {
	'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.json': 'application/json', '.wasm': 'application/wasm',
	'.txt': 'text/plain', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json',
};

createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost');
	if (!url.pathname.startsWith(BASE)) {
		res.writeHead(404).end('outside base path');
		return;
	}
	let path = url.pathname.slice(BASE.length) || '/';
	if (path.endsWith('/')) {
		path += 'index.html';
	}
	const file = normalize(join(ROOT, path));
	if (!file.startsWith(ROOT)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const body = await readFile(file);
		res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
}).listen(PORT, () => {
	console.log(`pages export at http://localhost:${PORT}${BASE}/`);
});
