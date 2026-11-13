/**
 * Local CORS proxy for yt-dlp WASM
 * Forwards browser fetch() requests to external origins, adding CORS headers.
 *
 * Usage:
 *   node proxy.mjs            → runs on http://localhost:8787
 *   PORT=9000 node proxy.mjs  → custom port
 *
 * The browser page sends requests as:
 *   http://localhost:8787/<encoded-target-url>
 * The proxy fetches the target and pipes the response back with CORS headers.
 */

import http  from 'http';
import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { URL, fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const PORT = process.env.PORT || 8787;

// Headers the proxy should NOT forward upstream (hop-by-hop)
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
  'host',  // will be replaced with target host
]);

// Headers the proxy should NOT send back to the browser
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

const server = http.createServer((req, res) => {
  // ── CORS pre-flight ──────────────────────────────────────────────────────────
  addCORSHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ── Health-check endpoint ────────────────────────────────────────────────────
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, proxy: 'yt-dlp-cors-proxy', port: PORT }));
  }

  // ── Serve static files (index.html, etc.) ───────────────────────────────────
  // A request is treated as a static file request when it starts with /static/
  // OR when the URL has no scheme (not a proxy target).
  const looksLikeProxy = /^\/https?[:\/]/.test(req.url) || /^\/https?%3A/.test(req.url);

  if (!looksLikeProxy) {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    // Strip query strings
    filePath = filePath.split('?')[0];
    const absPath = path.join(__dirname, filePath);
    const ext     = path.extname(absPath);

    try {
      const data = fs.readFileSync(absPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`Not found: ${filePath}`);
    }
  }

  // ── Parse target URL ─────────────────────────────────────────────────────────
  // Accepts both:
  //   /https%3A%2F%2Fexample.com%2Fpath    (URL-encoded)
  //   /https://example.com/path            (plain, some clients send this)
  let rawTarget = req.url.slice(1); // strip leading /
  let targetURL;
  try {
    targetURL = new URL(decodeURIComponent(rawTarget));
  } catch {
    try {
      targetURL = new URL(rawTarget);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end(`Bad target URL: ${rawTarget}`);
    }
  }

  if (!['http:', 'https:'].includes(targetURL.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Only http/https targets are allowed.');
  }

  // ── Build upstream request headers ───────────────────────────────────────────
  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) upstreamHeaders[k] = v;
  }
  upstreamHeaders['host'] = targetURL.host;

  const options = {
    hostname: targetURL.hostname,
    port:     targetURL.port || (targetURL.protocol === 'https:' ? 443 : 80),
    path:     targetURL.pathname + targetURL.search,
    method:   req.method,
    headers:  upstreamHeaders,
  };

  const lib = targetURL.protocol === 'https:' ? https : http;

  console.log(`→ ${req.method} ${targetURL.href}`);

  const upstream = lib.request(options, (upstreamRes) => {
    // Strip upstream CORS headers — we set our own
    const responseHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!STRIP_RESPONSE.has(k.toLowerCase())) responseHeaders[k] = v;
    }
    addCORSHeaders({ setHeader: (k, v) => { responseHeaders[k] = v; } });

    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);

    upstreamRes.on('error', err => {
      console.error('Upstream response error:', err.message);
      res.destroy();
    });
  });

  upstream.on('error', (err) => {
    console.error('Upstream request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Upstream error: ${err.message}`);
    }
  });

  // Pipe request body (for POST requests)
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

