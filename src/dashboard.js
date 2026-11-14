import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DashboardData } from './dashboard-data.js';
import { agentChanges } from './agent-changes.js';
import { getProviderQuota } from './quota-providers.js';
import { atomicWriteJson } from './storage.js';

export const defaultDashboardPort = 3141;
const currentScript = fileURLToPath(import.meta.url);
const assets = fileURLToPath(new URL('../dashboard/', import.meta.url));
const quotaCacheTtlMs = 60_000;

function streamSpeed(file, request, response, cleanups) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  });
  let last = 0;
  let closed = false;
  const push = () => {
    if (closed) return;
    try {
      const changed = fs.statSync(file).mtimeMs;
      if (changed === last) return;
      last = changed;
      response.write(`data: ${fs.readFileSync(file, 'utf8')}\n\n`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
  push();
  const timer = setInterval(push, 100);
  const ping = setInterval(() => { if (!closed) response.write(': ping\n\n'); }, 15000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(ping);
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  request.on('close', cleanup);
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
  let watcher = null;

  const pushIfChanged = () => {
    if (closed) return;
    const payload = data.list();
    const digest = JSON.stringify({
      agents: payload.agents,
      errors: payload.errors,
      groupNames: payload.groupNames,
    });
    if (digest === lastDigest) return;
    lastDigest = digest;
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const schedulePush = () => {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pushIfChanged();
    }, 50);
  };

  const attachWatcher = () => {
    if (closed || watcher || !fs.existsSync(root)) return;
    try {
      watcher = fs.watch(root, { recursive: true }, schedulePush);
    } catch (error) {
      if (error?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
        try { watcher = fs.watch(root, schedulePush); } catch (fallbackError) { if (fallbackError?.code !== 'ENOENT') throw fallbackError; }
      } else if (error?.code !== 'ENOENT') throw error;
    }
    if (watcher) {
      watcher.on('error', () => {
        try { watcher?.close(); } catch (closeError) { if (closeError?.code !== 'ENOENT') throw closeError; }
        watcher = null;
      });
    }
  };

  pushIfChanged();
  attachWatcher();
  const fallbackTimer = setInterval(() => {
    attachWatcher();
    pushIfChanged();
  }, 1000);
  const ping = setInterval(() => { if (!closed) response.write(': ping\n\n'); }, 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(fallbackTimer);
    clearInterval(ping);
    if (watcher) {
      try { watcher.close(); } catch (closeError) { if (closeError?.code !== 'ENOENT') throw closeError; }
      watcher = null;
    }
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  request.on('close', cleanup);
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
  let quotaCache = null;
  let quotaInflight = null;

  const readCachedQuota = async refresh => {
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

  const server = http.createServer((request, response) => {
    const send = (status, body, contentType = 'application/json') => {
      response.writeHead(status, {
        'content-type': `${contentType}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(contentType === 'application/json' ? JSON.stringify(body) : body);
    };
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
      const valid = value => {
        const actual = Buffer.from(value || '');
        const expected = Buffer.from(token);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      };
      if (!valid(cookie) && !valid((request.headers.authorization || '').replace(/^Bearer /, ''))) {
        send(401, { error: '查看会话已过期，请刷新面板页面。' });
        return;
      }
      if (request.method === 'POST') {
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
        return;
      }
      if (request.method !== 'GET') { send(405, { error: 'Method not allowed' }); return; }
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
    } catch (error) {
      send(error.message === 'Invalid agent ID' ? 400 : error.code === 'ENOENT' ? 404 : 500, { error: error.message });
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

async function checkExistingViewer(root, port) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'dashboard.json'), 'utf8'));
    if (Number(new URL(info.url).port) !== port) return false;
    const response = await fetch(new URL('/api/health', info.url), {
      headers: { authorization: `Bearer ${info.token || ''}` },
      signal: AbortSignal.timeout(1000),
    });
    const health = await response.json();
    return response.ok && health.service === 'pi-dashboard' && health.scriptPath === currentScript;
  } catch (error) {
    if (error) return false;
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentScript) {
  const root = process.env.PI_SUBAGENTS_STATE_DIR || fileURLToPath(new URL('../.agents/runtime/', import.meta.url));
  const port = Number(process.env.PI_DASHBOARD_PORT || defaultDashboardPort);
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
    if (error?.code === 'EADDRINUSE' && await checkExistingViewer(root, port)) {
      process.exit(0);
    }
    console.error(error?.message || String(error));
    process.exit(1);
  }
}
