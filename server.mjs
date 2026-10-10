import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { DuelService, ApiError } from './online/service.mjs';
import { MemoryStore } from './online/store.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8' };
const BODY_LIMIT = 16 * 1024;

function originList(value) {
  return (Array.isArray(value) ? value : String(value ?? '').split(',')).filter(Boolean).map(item => {
    const url = new URL(String(item).trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Configure complete HTTP(S) origins without paths or credentials.');
    return url.origin;
  });
}

/** Hosting configuration is explicit; durable localhost remains the default. */
export function hostingOptions(env = process.env, args = process.argv.slice(2)) {
  const value = (flag, fallback) => { const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1]; };
  const mode = env.SESSION_MODE || 'persistent';
  if (!['persistent', 'temporary'].includes(mode)) throw new Error('SESSION_MODE must be persistent or temporary.');
  const port = Number(value('--port', env.PORT || '4173'));
  const host = value('--host', env.HOST || (env.PORT ? '0.0.0.0' : '127.0.0.1'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port from 1 to 65535.');
  if (typeof host !== 'string' || !host.trim()) throw new Error('Choose a valid host.');
  return {
    host, port, temporarySessions: mode === 'temporary',
    publicOrigins: originList(env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL),
    embedOrigins: originList(env.EMBED_ORIGINS),
    ...(env.DATA_FILE ? { storePath: resolve(env.DATA_FILE) } : {}),
  };
}

/** One finite byte range is enough for browser video metadata and seeking. */
export function parseMediaRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return false;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return false;
  if (first === undefined) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : false;
  if (first >= size || (last !== undefined && last < first)) return false;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ApiError(415, 'Send an application/json request.');
  if (Number(request.headers['content-length']) > BODY_LIMIT) throw new ApiError(413, 'Request body is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Send valid JSON.'); }
}
function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

/** Local defaults; set host explicitly to expose the same server to other devices. */
export function createAppServer(options = {}) {
  const temporarySessions = options.temporarySessions === true;
  const publicOrigins = originList(options.publicOrigins ?? options.publicOrigin);
  const embedOrigins = originList(options.embedOrigins);
  const service = new DuelService({ storePath: resolve(root, '.local-data/online-duels.json'), ...options,
    ...(temporarySessions && !options.store ? { store: new MemoryStore() } : {}), temporarySessions });
  const limits = new Map();
  function rate(request, pathname, token) {
    const now = Date.now(), ip = request.socket.remoteAddress ?? 'local';
    const hash = token ? createHash('sha256').update(token).digest('hex') : null;
    // Authenticated players have separate quotas even behind one hosting proxy.
    // Unknown/forged tokens share the anonymous bucket; forwarded headers confer no trust.
    const creating = request.method === 'POST' && pathname === '/api/session';
    const key = !creating && hash && service.data?.sessions[hash] ? `guest:${hash}` : `ip:${ip}`;
    let record = limits.get(key);
    if (!record || now - record.start >= 60000) {
      record = { start: now, requests: 0, sessions: 0 }; limits.set(key, record);
      if (limits.size > 10000) for (const [key, entry] of limits) if (now - entry.start >= 60000) limits.delete(key);
    }
    record.requests += 1;
    if (creating) record.sessions += 1;
    if (record.requests > 600 || record.sessions > 30) throw new ApiError(429, 'Too many requests. Try again shortly.', 'rate_limited');
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    const frameParents = embedOrigins.length ? `'self' ${embedOrigins.join(' ')}` : "'none'";
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${frameParents}`);
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch { throw new ApiError(400, 'Bad request.'); }
      if (pathname === '/healthz' && ['GET', 'HEAD'].includes(request.method)) {
        await service.initialized;
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); }
        else json(response, 200, { status: 'ok', sessionMode: temporarySessions ? 'temporary' : 'persistent' });
        return;
      }
      if (pathname.startsWith('/api/')) {
        await service.initialized;
        const bearer = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? '');
        rate(request, pathname, bearer?.[1]);
        if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
        if (request.method === 'POST') {
          const origin = request.headers.origin;
          const allowed = publicOrigins.length ? publicOrigins : [`http://${request.headers.host}`];
          if (request.headers['sec-fetch-site'] === 'cross-site' || (origin !== undefined && !allowed.includes(origin))) throw new ApiError(403, 'Cross-origin changes are not allowed.', 'forbidden_origin');
        }
        const body = request.method === 'POST' ? await readJson(request) : undefined;
        const result = await service.request({ method: request.method, path: pathname, token: bearer?.[1], body });
        json(response, 200, result); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
      if (pathname === '/') pathname = '/index.html';
      const publicAsset = /^\/assets\/(?:dpixel-avatar|arena|clean-gladiator|armory|first-person)\/[a-zA-Z0-9/_.-]+\.(png|json)$/.test(pathname) && !pathname.split('/').includes('..');
      const publicMedia = /^\/public\/cinematics\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(mp4|jpg|png)$/.test(pathname);
      const publicAudio = /^\/public\/audio\/soundtrack-v\d+\/[a-zA-Z0-9_-]+\.(mp3|json)$/.test(pathname);
      if (pathname !== '/index.html' && !/^\/src\/[a-zA-Z0-9/_-]+\.(js|css|svg)$/.test(pathname) && !publicAsset && !publicMedia && !publicAudio) throw new ApiError(404, 'Not found.');
      const target = resolve(root, `.${pathname}`);
      if (!target.startsWith(`${resolve(root)}${sep}`)) throw new ApiError(403, 'Forbidden.');
      if (publicMedia || publicAudio && extname(target) === '.mp3') {
        let info;
        try { info = await stat(target); } catch { throw new ApiError(404, 'Not found.'); }
        if (!info.isFile()) throw new ApiError(404, 'Not found.');
        const range = parseMediaRange(request.headers.range, info.size);
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        response.setHeader('Content-Type', types[extname(target)]);
        if (range === false) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 });
          response.end(); return;
        }
        const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
        response.setHeader('Content-Length', end - start + 1);
        if (range) response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
        response.writeHead(range ? 206 : 200);
        if (request.method === 'HEAD') response.end();
        else await pipeline(createReadStream(target, { start, end }), response);
        return;
      }
      let content;
      try { content = await readFile(target); } catch { throw new ApiError(404, 'Not found.'); }
      if (pathname === '/index.html') content = Buffer.from(content.toString('utf8').replace('</head>', `    <meta name="arena-session-mode" content="${temporarySessions ? 'temporary' : 'persistent'}">\n  </head>`));
      response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (error instanceof ApiError) json(response, error.status, { error: error.message, code: error.code });
      else {
        console.error('Online duel request failed:', error.message);
        json(response, 500, { error: 'The server could not save this request. Please retry.', code: 'server_error' });
      }
    }
  });
  server.duels = service;
  const interval = setInterval(() => { service.tick().catch(error => console.error('Online duel deadline failed:', error.message)); }, options.tickMs ?? 1000);
  interval.unref();
  server.on('close', () => clearInterval(interval));
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port, ...options } = hostingOptions();
  const server = createAppServer(options);
  server.on('error', error => { console.error(`Could not start the prototype: ${error.message}`); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Arena Fighters: http://${host}:${port}\nPress Ctrl+C to stop.`));
}
