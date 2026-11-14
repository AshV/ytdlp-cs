/**
 * Local CORS proxy + static file server for yt-dlp WASM
 *
 * Usage:
 *   node proxy.mjs            → runs on http://localhost:8787
 *   PORT=9000 node proxy.mjs  → custom port
 *
 * Routes:
 *   GET /                        → serves index.html
 *   GET /ping                    → health check JSON
 *   GET /<full-url>              → CORS proxy  (e.g. /https://youtube.com/...)
 *   GET /?url=<full-url>         → CORS proxy  (query-param format)
 *   GET /<url-encoded-url>       → CORS proxy  (percent-encoded format)
 */

import http  from 'http';
import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

// MIME types for static file serving
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// Headers NOT forwarded upstream (hop-by-hop)
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

// Headers NOT sent back to browser (we set our own CORS headers)
const STRIP_RESPONSE = new Set([
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
]);

function addCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers','Content-Length, Content-Range, Content-Type');
}

// Try to parse a string as a URL; return null on failure
function tryParseURL(str) {
  try { return new URL(str); } catch { return null; }
}

// Resolve a target URL from the request, supporting three formats
function resolveTarget(req) {
  const parsed = new URL(req.url, 'http://localhost');

  // Format 1: /?url=https://...
  const qp = parsed.searchParams.get('url');
  if (qp) return tryParseURL(qp);

  // Format 2 & 3: /https://... or /https%3A%2F%2F...
  const stripped = req.url.slice(1);
  if (stripped) {
    return tryParseURL(decodeURIComponent(stripped)) || tryParseURL(stripped);
  }

  return null;
}

const server = http.createServer((req, res) => {
  // ── CORS pre-flight ──────────────────────────────────────────────────────────
  addCORSHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── Health-check ─────────────────────────────────────────────────────────────
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, proxy: 'yt-dlp-cors-proxy', port: PORT }));
  }

  // ── Debug: log every request ─────────────────────────────────────────────────
  console.log(`→ ${req.method} ${req.url}`);

  // ── Try to resolve as a proxy target ─────────────────────────────────────────
  const targetURL = resolveTarget(req);

  if (!targetURL || !['http:', 'https:'].includes(targetURL.protocol)) {
    // Not a proxy request → serve static file
    const parsed = new URL(req.url, 'http://localhost');
    const filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    const absPath  = path.join(__dirname, filePath);
    const ext      = path.extname(absPath);

    try {
      const data = fs.readFileSync(absPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`Not found: ${filePath}`);
    }
  }

  // ── Proxy request upstream ───────────────────────────────────────────────────
  console.log(`  ↳ proxy → ${targetURL.href}`);

  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) upstreamHeaders[k] = v;
  }
  upstreamHeaders['host'] = targetURL.host;

  // Inject browser-like headers for Google/YouTube bot detection bypass.
  // These are only set if the client didn't already supply them.
  const isGoogleDomain = targetURL.hostname.endsWith('google.com') ||
                         targetURL.hostname.endsWith('youtube.com') ||
                         targetURL.hostname.endsWith('googlevideo.com') ||
                         targetURL.hostname.endsWith('ytimg.com');

  if (!upstreamHeaders['user-agent']) {
    upstreamHeaders['user-agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  if (isGoogleDomain) {
    upstreamHeaders['accept']          ??= 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    upstreamHeaders['accept-language'] ??= 'en-US,en;q=0.9';
    upstreamHeaders['accept-encoding'] ??= 'gzip, deflate, br';
    upstreamHeaders['sec-fetch-site']  ??= 'none';
    upstreamHeaders['sec-fetch-mode']  ??= 'navigate';
    upstreamHeaders['sec-fetch-dest']  ??= 'document';
    // Remove headers that reveal automation
    delete upstreamHeaders['origin'];
    delete upstreamHeaders['referer'];
  }

  const options = {
    hostname: targetURL.hostname,
    port:     targetURL.port || (targetURL.protocol === 'https:' ? 443 : 80),
    path:     targetURL.pathname + targetURL.search,
    method:   req.method,
    headers:  upstreamHeaders,
  };

  const lib = targetURL.protocol === 'https:' ? https : http;

  const upstream = lib.request(options, (upstreamRes) => {
    const responseHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) responseHeaders[k] = v;
    }
    addCORSHeaders({ setHeader: (k, v) => { responseHeaders[k] = v; } });
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
    upstreamRes.on('error', err => { console.error('Upstream response error:', err.message); res.destroy(); });
  });

  upstream.on('error', (err) => {
    console.error('Upstream request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Upstream error: ${err.message}`);
    }
  });

  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ✅  yt-dlp CORS proxy + static server running');
  console.log(`  🌐  Open in browser → http://localhost:${PORT}/`);
  console.log(`  🏓  Health check    → http://localhost:${PORT}/ping`);
  console.log('');
  console.log('  ⚠  Open the URL above — do NOT use the file:// path directly.');
  console.log('  Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌  Port ${PORT} is already in use.`);
    console.error(`  Try: PORT=9000 node proxy.mjs\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
