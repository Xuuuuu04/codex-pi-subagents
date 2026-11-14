import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DashboardData, defaultDashboardPort, parseDashboardPort, readRunningDashboard } from './dashboard-data.js';
import { agentChanges } from './agent-changes.js';
import { getProviderQuota } from './quota-providers.js';
import { atomicWriteJson } from './storage.js';

export { defaultDashboardPort };
const currentScript = fileURLToPath(import.meta.url);
const assets = fileURLToPath(new URL('../dashboard/', import.meta.url));
const quotaCacheTtlMs = 60_000;

function writeSse(response, payload, cleanup) {
  if (response.writableEnded || response.destroyed) {
    cleanup();
    return false;
  }
  try {
    response.write(payload);
    return true;
  } catch (error) {
    cleanup();
    console.error(error?.message || String(error));
    return false;
  }
}

function streamSpeed(file, request, response, cleanups) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  let last = 0;
  let closed = false;
  let timer = null;
  let ping = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
    cleanups.delete(cleanup);
  };
  writeSse(response, ': ok\n\n', cleanup);
  const push = () => {
    if (closed) return;
    try {
      const changed = fs.statSync(file).mtimeMs;
      if (changed === last) return;
      last = changed;
      writeSse(response, `data: ${fs.readFileSync(file, 'utf8')}\n\n`, cleanup);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      cleanup();
      if (!response.writableEnded) response.end();
      console.error(error?.message || String(error));
    }
  };
  push();
  if (closed) return;
  timer = setInterval(push, 100);
  ping = setInterval(() => { if (!closed) writeSse(response, ': ping\n\n', cleanup); }, 15000);
  cleanups.add(cleanup);
  request.on('close', cleanup);
  response.on('close', cleanup);
}

function streamAgentEvents(root, data, request, response, cleanups) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  let closed = false;
  let lastDigest = null;
  let debounceTimer = null;
  let fallbackTimer = null;
  let ping = null;
  let watcher = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(fallbackTimer);
    clearInterval(ping);
    if (watcher) {
      try { watcher.close(); } catch (closeError) { if (closeError?.code !== 'ENOENT') console.error(closeError?.message || String(closeError)); }
      watcher = null;
    }
    cleanups.delete(cleanup);
  };
  const pushIfChanged = () => {
    if (closed) return;
    try {
      const payload = data.list();
      const digest = JSON.stringify({ agents: payload.agents, errors: payload.errors, groupNames: payload.groupNames });
      if (digest === lastDigest) return;
      lastDigest = digest;
      writeSse(response, `data: ${JSON.stringify(payload)}\n\n`, cleanup);
    } catch (error) {
      cleanup();
      if (!response.writableEnded) response.end();
      console.error(error?.message || String(error));
    }
  };
  const schedulePush = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => { debounceTimer = null; pushIfChanged(); }, 50);
  };
  const attachWatcher = () => {
    if (closed || watcher || !fs.existsSync(root)) return;
    try { watcher = fs.watch(root, { recursive: true }, schedulePush); }
    catch (error) {
      if (error?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        try { watcher = fs.watch(root, schedulePush); } catch (fallbackError) { if (fallbackError?.code !== 'ENOENT') throw fallbackError; }
      } else if (error?.code !== 'ENOENT') throw error;
    }
    watcher?.on('error', error => {
      if (error?.code !== 'ENOENT') console.error(error?.message || String(error));
      try { watcher?.close(); } catch (closeError) { if (closeError?.code !== 'ENOENT') console.error(closeError?.message || String(closeError)); }
      watcher = null;
    });
  };
  pushIfChanged();
  attachWatcher();
  if (closed) return;
  fallbackTimer = setInterval(() => {
    try { attachWatcher(); pushIfChanged(); }
    catch (error) { cleanup(); if (!response.writableEnded) response.end(); console.error(error?.message || String(error)); }
  }, 1000);
  ping = setInterval(() => { if (!closed) writeSse(response, ': ping\n\n', cleanup); }, 15000);
  cleanups.add(cleanup);
  request.on('close', cleanup);
  response.on('close', cleanup);
}

function mapHttpErrorStatus(error) {
  return error.message === 'Invalid agent ID' ? 400 : error.code === 'ENOENT' ? 404 : 500;
}

function createQuotaReader(fetchQuota) {
  let quotaCache = null;
  let quotaInflight = null;
  return async refresh => {
    if (!refresh && quotaCache && Date.now() - quotaCache.at < quotaCacheTtlMs) {
      return { ...quotaCache.value, cached: true };
    }
    if (!quotaInflight) {
      quotaInflight = (async () => {
        try {
          const result = await fetchQuota();
          const value = { ...result, cached: false };
          quotaCache = { at: Date.now(), value };
          return value;
        } catch (error) {
          return {
            queriedAt: new Date().toISOString(),
            results: [],
            unsupportedProviders: [],
            cached: false,
            error: error.message,
          };
        } finally {
          quotaInflight = null;
        }
      })();
    }
    return quotaInflight;
  };
}

function sendResponse(response, status, body, contentType = 'application/json') {
  response.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(contentType === 'application/json' ? JSON.stringify(body) : body);
}

function handlePostRequest(request, url, site, data, send) {
  if (request.headers['x-pi-dashboard'] !== '1' || site === 'cross-site') { send(403, { error: 'Invalid request' }); return; }
  const write = /^\/api\/agents\/([^/]+)\/(mark|move)$/.exec(url.pathname);
  if (!write && url.pathname !== '/api/groups') { send(404, { error: 'Not found' }); return; }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 2000) request.destroy(); });
  request.on('end', () => {
    try {
      const value = JSON.parse(body || '{}');
      send(200, !write ? data.renameGroup(value.key, value.name ?? null) : write[2] === 'mark' ? data.mark(write[1], value.status ?? null) : data.move(write[1], value.group ?? null));
    } catch (error) { send(400, { error: error.message }); }
  });
}

function handleGetRequest({ request, response, url, root, data, cleanups, readCachedQuota, send }) {
  if (url.pathname === '/api/health') { send(200, { service: 'pi-dashboard', pid: process.pid, scriptPath: currentScript }); return; }
  if (url.pathname === '/api/agents') { send(200, data.list()); return; }
  if (url.pathname === '/api/system') { send(200, data.systemStatus()); return; }
  if (url.pathname === '/api/quota') {
    readCachedQuota(url.searchParams.get('refresh') === '1').then(
      result => send(200, result),
      error => send(500, { error: error.message }),
    );
    return;
  }
  if (url.pathname === '/api/events') { streamAgentEvents(root, data, request, response, cleanups); return; }
  const changes = /^\/api\/agents\/([^/]+)\/changes$/.exec(url.pathname);
  if (changes) {
    const record = JSON.parse(fs.readFileSync(path.join(data.directory(changes[1]), 'agent.json'), 'utf8'));
    agentChanges(record, { includeDiff: true, maxBytes: 600000 }).then(result => send(200, result), error => send(400, { error: error.message }));
    return;
  }
  const stream = /^\/api\/agents\/([^/]+)\/speed$/.exec(url.pathname);
  if (stream) { streamSpeed(path.join(data.directory(stream[1]), 'speed.json'), request, response, cleanups); return; }
  const match = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
  if (match) { send(200, data.detail(match[1])); return; }
  send(404, { error: 'Not found' });
}

export async function startDashboard({
  root,
  port = defaultDashboardPort,
  token = randomBytes(32).toString('hex'),
  fetchQuota = () => getProviderQuota({ provider: 'all', signal: AbortSignal.timeout(4000) }),
}) {
  const data = new DashboardData(root);
  const cleanups = new Set();
  const files = new Map([
    ['/', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']],
    ['/dom.js', ['dom.js', 'text/javascript']],
    ['/panels.js', ['panels.js', 'text/javascript']],
    ['/dialogs.js', ['dialogs.js', 'text/javascript']],
    ['/sidebar.js', ['sidebar.js', 'text/javascript']],
    ['/conversation.js', ['conversation.js', 'text/javascript']],
    ['/charts.js', ['charts.js', 'text/javascript']],
    ['/style.css', ['style.css', 'text/css']],
  ]);
  const readCachedQuota = createQuotaReader(fetchQuota);
  const validToken = value => {
    const actual = Buffer.from(value || '');
    const expected = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const server = http.createServer((request, response) => {
    const send = (status, body, contentType) => sendResponse(response, status, body, contentType);
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== host) { send(403, { error: 'Invalid host' }); return; }
      if (request.method !== 'GET' && request.method !== 'POST') { send(405, { error: 'Method not allowed' }); return; }
      const url = new URL(request.url, `http://${host}`);
      const site = request.headers['sec-fetch-site'];
      if (site && !['same-origin', 'none'].includes(site) && !(url.pathname === '/' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document')) {
        send(403, { error: 'Cross-site dashboard requests are not allowed' });
        return;
      }
      const cookieName = `pi_dashboard_${server.address().port}`;
      if (files.has(url.pathname)) {
        if (url.pathname === '/') response.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`);
        const [file, type] = files.get(url.pathname);
        send(200, fs.readFileSync(path.join(assets, file)), type);
        return;
      }
      const cookie = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!validToken(cookie) && !validToken((request.headers.authorization || '').replace(/^Bearer /, ''))) {
        send(401, { error: '查看会话已过期，请刷新面板页面。' });
        return;
      }
      if (request.method === 'POST') { handlePostRequest(request, url, site, data, send); return; }
      handleGetRequest({ request, response, url, root, data, cleanups, readCachedQuota, send });
    } catch (error) {
      send(mapHttpErrorStatus(error), { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    token,
    url: `http://127.0.0.1:${actualPort}/`,
    close: () => {
      for (const fn of [...cleanups]) fn();
      server.closeAllConnections?.();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentScript) {
  const root = process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime/', import.meta.url));
  const port = parseDashboardPort();
  try {
    const dashboard = await startDashboard({ root, port });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    atomicWriteJson(path.join(root, 'dashboard.json'), {
      pid: process.pid,
      url: dashboard.url,
      token: dashboard.token,
      scriptPath: currentScript,
      startedAt: new Date().toISOString(),
    });
    const stop = () => dashboard.close().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    const existing = error?.code === 'EADDRINUSE' ? await readRunningDashboard(root, { checkPidMatch: false, timeoutMs: 1000 }) : null;
    if (existing && existing.scriptPath === currentScript && Number(new URL(existing.url).port) === port) {
      process.exit(0);
    }
    console.error(error?.message || String(error));
    process.exit(1);
  }
}
